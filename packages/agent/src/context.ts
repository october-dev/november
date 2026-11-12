import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, type AgentLimits } from "./limits.js";

/**
 * Drop the oldest conversation groups until the transcript fits the context
 * budget. The leading system prompt stays. Tool results stay attached to the
 * assistant message that requested them, so a trimmed transcript is still a
 * valid provider payload. Tool text is never copied into the system prompt.
 */
export function boundContext(
  messages: readonly AgentMessage[],
  limits: AgentLimits,
): AgentMessage[] {
  if (messages.length === 0) return [];

  const system: AgentMessage[] = [];
  const groups: AgentMessage[][] = [];
  for (const message of messages) {
    if (system.length === 0 && message.role === "system") {
      system.push(message);
      continue;
    }
    const previous = groups[groups.length - 1];
    if (message.role === "toolResult" && previous) {
      previous.push(message);
      continue;
    }
    groups.push([message]);
  }

  const selected = groups.slice();
  while (
    selected.length > 1 &&
    overBudget([...system, ...selected.flat()], limits)
  ) {
    selected.shift();
  }

  let bounded = [...system, ...selected.flat()];
  if (overBudget(bounded, limits)) {
    bounded = truncateToBudget(bounded, limits);
  }
  return bounded;
}

function overBudget(
  messages: readonly AgentMessage[],
  limits: AgentLimits,
): boolean {
  return (
    messages.length > limits.maxContextMessages ||
    estimateTokens(messages) > limits.maxContextTokens
  );
}

function truncateToBudget(
  messages: readonly AgentMessage[],
  limits: AgentLimits,
): AgentMessage[] {
  const charBudget = limits.maxContextTokens * 4;
  const copy = messages.map((message) => ({ ...message }));
  const last = copy[copy.length - 1];
  if (!last) return copy;
  const serialized = JSON.stringify(copy);
  if (serialized.length <= charBudget) return copy;
  const overflow = serialized.length - charBudget;
  if ("content" in last && typeof last.content === "string") {
    last.content = last.content.slice(
      0,
      Math.max(0, last.content.length - overflow),
    );
    return copy;
  }
  if ("content" in last && Array.isArray(last.content)) {
    const parts = last.content.map((part) =>
      part.type === "text"
        ? {
            ...part,
            text: part.text.slice(0, Math.max(0, part.text.length - overflow)),
          }
        : part,
    );
    return copy.map((message, index) =>
      index === copy.length - 1
        ? ({ ...message, content: parts } as AgentMessage)
        : message,
    );
  }
  return copy;
}
