import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, type AgentLimits } from "./limits.js";

/**
 * Drop the oldest conversation groups until the transcript fits the context
 * budget. The leading system prompt and the current run's prompt (the most
 * recent user message) are required context: if they alone exceed a cap,
 * this throws instead of sending an oversized, broken, or prompt-less
 * request. Tool results stay attached to the assistant message that
 * requested them, so a trimmed transcript is still a valid provider
 * payload. Tool text is never copied into the system prompt, and tool
 * arguments are never altered to fake a fit.
 */
export function boundContext(
  messages: readonly AgentMessage[],
  limits: AgentLimits,
): AgentMessage[] {
  if (messages.length === 0) return [];

  const system: AgentMessage[] = [];
  const rest: AgentMessage[] = [];
  let leading = true;
  for (const message of messages) {
    if (leading && message.role === "system") {
      system.push(message);
      continue;
    }
    leading = false;
    rest.push(message);
  }
  const groups = groupMessages(rest);
  const promptIndex = groups.findLastIndex((group) =>
    group.some((message) => message.role === "user"),
  );
  // The system prompt and the current prompt (the most recent user
  // message) can never be dropped. Everything else slides oldest-first.
  const prompt: AgentMessage[] =
    promptIndex < 0 ? [] : (groups[promptIndex] ?? []);
  const before = promptIndex < 0 ? [...groups] : groups.slice(0, promptIndex);
  const after = promptIndex < 0 ? [] : groups.slice(promptIndex + 1);
  const required = [...system, ...prompt];
  if (overBudget(required, limits)) {
    throw new Error(
      "required context exceeds the budget: the system prompt and the current prompt cannot fit",
    );
  }
  const keptBefore = [...before];
  const keptAfter = [...after];
  const assembled = () => [
    ...system,
    ...keptBefore.flat(),
    ...prompt,
    ...keptAfter.flat(),
  ];
  while (keptBefore.length > 0 && overBudget(assembled(), limits)) {
    keptBefore.shift();
  }
  while (keptAfter.length > 0 && overBudget(assembled(), limits)) {
    keptAfter.shift();
  }
  const bounded = assembled();
  if (overBudget(bounded, limits)) {
    throw new Error(
      "required context exceeds the budget: the transcript cannot fit",
    );
  }
  return bounded;
}

function groupMessages(messages: readonly AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = [];
  for (const message of messages) {
    const previous = groups[groups.length - 1];
    if (message.role === "toolResult" && previous) {
      previous.push(message);
      continue;
    }
    groups.push([message]);
  }
  return groups;
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
