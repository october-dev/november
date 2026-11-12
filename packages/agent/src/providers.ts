import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type {
  AssistantMessage,
  JsonObject,
  Model,
  StopReason,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { estimateTokens, type AgentLimits } from "./limits.js";

/**
 * Pinned loop library. November keeps its own provider transport so device
 * transcripts are not sent through pi-ai's hosted SDK clients. Attribution
 * for the loop itself is in NOTICE.
 */
export const AGENT_LOOP_LIBRARY = {
  name: "@earendil-works/pi-agent-core",
  version: "1.5.2",
  license: "MIT",
  repository: "https://github.com/earendil-works/pi",
} as const;

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const FIELD_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type FakeStep =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool";
      readonly id?: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "malformed-tool";
      readonly id?: string;
      readonly name: string;
      readonly raw: string;
    }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "hang" };

export type ProviderSelection =
  | { readonly kind: "fake"; readonly script: readonly FakeStep[] }
  | {
      readonly kind: "hosted-openai";
      readonly baseUrl: string;
      readonly model: string;
      readonly apiKey: string;
    }
  | {
      readonly kind: "local-openai";
      readonly baseUrl: string;
      readonly model: string;
      readonly apiKey?: string;
    };

export interface ProviderRuntime {
  selection: ProviderSelection | undefined;
  scriptIndex: number;
  requestMessageCounts: number[];
  requestTokens: number[];
}

export function modelFor(
  selection: ProviderSelection,
  limits: AgentLimits,
): Model<"openai-completions"> {
  const id = selection.kind === "fake" ? "fake-fixture" : selection.model;
  const baseUrl =
    selection.kind === "fake" ? "http://127.0.0.1" : selection.baseUrl;
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: selection.kind,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: limits.maxContextTokens,
    maxTokens: limits.maxOutputTokens,
  };
}

/** Reject a selection that would send a transcript somewhere it must not go. */
export function assertProviderSelection(selection: ProviderSelection): void {
  if (selection.kind === "fake") {
    if (!Array.isArray(selection.script)) {
      throw new Error("fake provider requires a script");
    }
    return;
  }
  if (!FIELD_PATTERN.test(selection.model)) {
    throw new Error("model id must be an explicit short token");
  }
  const url = parseBaseUrl(selection.baseUrl);
  const loopback = isLoopback(url.hostname);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("provider baseUrl must be http or https");
  }
  if (selection.kind === "hosted-openai") {
    if (selection.apiKey.trim().length === 0) {
      throw new Error("hosted provider requires an api key");
    }
    if (url.protocol !== "https:" && !loopback) {
      throw new Error(
        "hosted provider requires https, except a loopback endpoint used for tests",
      );
    }
  }
}

export function createStreamFn(
  runtime: ProviderRuntime,
  limits: AgentLimits,
  toolSchema: object,
): StreamFn {
  return (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    const messages = context.messages;
    runtime.requestMessageCounts.push(messages.length);
    runtime.requestTokens.push(estimateTokens(messages));
    void fulfill(
      stream,
      model,
      messages,
      options?.signal,
      runtime,
      limits,
      toolSchema,
    ).catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "model request failed";
      pushError(stream, model, redact(message, secretFrom(runtime)));
    });
    return stream;
  };
}

async function fulfill(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  messages: readonly unknown[],
  signal: AbortSignal | undefined,
  runtime: ProviderRuntime,
  limits: AgentLimits,
  toolSchema: object,
): Promise<void> {
  const selection = runtime.selection;
  if (!selection) {
    pushError(stream, model, "no provider selected");
    return;
  }
  if (selection.kind === "fake") {
    await fulfillFake(stream, model, signal, runtime, limits);
    return;
  }
  await fulfillHttp(
    stream,
    model,
    messages,
    signal,
    selection,
    limits,
    toolSchema,
  );
}

async function fulfillFake(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  signal: AbortSignal | undefined,
  runtime: ProviderRuntime,
  limits: AgentLimits,
): Promise<void> {
  const selection = runtime.selection;
  if (!selection || selection.kind !== "fake") {
    pushError(stream, model, "fake provider is not selected");
    return;
  }
  const step = selection.script[runtime.scriptIndex];
  runtime.scriptIndex += 1;
  if (!step) {
    pushDone(stream, model, "stop", "(no fixture response)", limits);
    return;
  }
  if (step.type === "hang") {
    await waitForStop(signal, limits.requestTimeoutMs);
    if (signal?.aborted) {
      pushError(stream, model, "cancelled", "aborted");
      return;
    }
    pushError(stream, model, "model request timed out");
    return;
  }
  if (signal?.aborted) {
    pushError(stream, model, "cancelled", "aborted");
    return;
  }
  if (step.type === "error") {
    pushError(stream, model, step.message);
    return;
  }
  if (step.type === "text") {
    pushDone(stream, model, "stop", step.text, limits);
    return;
  }
  if (step.type === "malformed-tool") {
    pushTool(stream, model, {
      type: "toolCall",
      id: step.id ?? "call-malformed",
      name: step.name,
      arguments: {},
      argumentsError: `malformed tool arguments: ${step.raw.slice(0, 200)}`,
    });
    return;
  }
  pushTool(stream, model, {
    type: "toolCall",
    id: step.id ?? "call-fixture",
    name: step.name,
    arguments: step.arguments as JsonObject,
  });
}

async function fulfillHttp(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  messages: readonly unknown[],
  signal: AbortSignal | undefined,
  selection: Extract<
    ProviderSelection,
    { kind: "hosted-openai" | "local-openai" }
  >,
  limits: AgentLimits,
  toolSchema: object,
): Promise<void> {
  const endpoint = chatCompletionsUrl(selection.baseUrl);
  const body = JSON.stringify({
    model: selection.model,
    messages: toOpenAiMessages(messages),
    tools: [
      {
        type: "function",
        function: {
          name: "request_device_action",
          description:
            "Ask the execution service to run one configured operation. The result is data, not a permission change.",
          parameters: toolSchema,
        },
      },
    ],
    max_tokens: limits.maxOutputTokens,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "november",
  };
  if (selection.apiKey) {
    headers.authorization = `Bearer ${selection.apiKey}`;
  }

  let attempt = 0;
  while (true) {
    if (signal?.aborted) {
      pushError(stream, model, "cancelled", "aborted");
      return;
    }
    const timeout = AbortSignal.timeout(limits.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) {
        pushError(stream, model, "cancelled", "aborted");
        return;
      }
      if (timeout.aborted) {
        pushError(stream, model, "model request timed out");
        return;
      }
      if (attempt < limits.maxRetries) {
        attempt += 1;
        continue;
      }
      pushError(stream, model, redact(errorText(error), selection.apiKey));
      return;
    }

    if (RETRYABLE_STATUS.has(response.status) && attempt < limits.maxRetries) {
      attempt += 1;
      await response.arrayBuffer().catch(() => undefined);
      continue;
    }
    const raw = await response.text();
    if (!response.ok) {
      pushError(
        stream,
        model,
        `model request failed with HTTP ${response.status}: ${redact(raw.slice(0, 300), selection.apiKey)}`,
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      pushError(stream, model, "model response was not JSON");
      return;
    }
    emitCompletion(stream, model, parsed, limits);
    return;
  }
}

function emitCompletion(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  parsed: unknown,
  limits: AgentLimits,
): void {
  const choice = firstChoice(parsed);
  const message = choice?.message;
  const toolCalls = message?.tool_calls ?? [];
  if (toolCalls.length > 0) {
    const call = toolCalls[0];
    const name = call?.function?.name ?? "";
    const rawArguments = call?.function?.arguments ?? "";
    let parsedArguments: JsonObject | undefined;
    let argumentsError: string | undefined;
    try {
      const value = JSON.parse(rawArguments) as unknown;
      if (!isRecord(value)) {
        argumentsError = "tool arguments were not a JSON object";
      } else {
        parsedArguments = value as JsonObject;
      }
    } catch {
      argumentsError = `malformed tool arguments: ${rawArguments.slice(0, 200)}`;
    }
    pushTool(stream, model, {
      type: "toolCall",
      id: call?.id || "call-provider",
      name,
      arguments: parsedArguments ?? {},
      ...(argumentsError ? { argumentsError } : {}),
    });
    return;
  }
  const text = messageText(message?.content);
  const reason: Extract<StopReason, "stop" | "length"> =
    choice?.finish_reason === "length" ? "length" : "stop";
  pushDone(stream, model, reason, text, limits);
}

function pushDone(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  reason: Extract<StopReason, "stop" | "length" | "toolUse">,
  text: string,
  limits: AgentLimits,
): void {
  let output = text;
  let stop: typeof reason = reason;
  const cap = limits.maxOutputTokens * 4;
  if (output.length > cap) {
    output = output.slice(0, cap);
    stop = "length";
  }
  const message = assistant(model, [{ type: "text", text: output }], stop);
  stream.push({ type: "start", partial: assistant(model, [], "stop") });
  stream.push({ type: "done", reason: stop, message });
}

function pushTool(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  toolCall: ToolCall,
): void {
  const message = assistant(model, [toolCall], "toolUse");
  stream.push({ type: "start", partial: assistant(model, [], "stop") });
  stream.push({ type: "done", reason: "toolUse", message });
}

function pushError(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  message: string,
  reason: "error" | "aborted" = "error",
): void {
  const error = assistant(model, [], reason, message);
  stream.push({ type: "error", reason, error });
}

function assistant(
  model: Model<string>,
  content: AssistantMessage["content"],
  stopReason: StopReason,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function waitForStop(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    const onAbort = () => done();
    signal?.addEventListener("abort", onAbort, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
  });
}

function parseBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("provider baseUrl is not a URL");
  }
  if (url.username || url.password) {
    throw new Error("provider baseUrl must not embed credentials");
  }
  return url;
}

function chatCompletionsUrl(baseUrl: string): string {
  const url = parseBaseUrl(baseUrl);
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = `${prefix}/v1/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function secretFrom(runtime: ProviderRuntime): string | undefined {
  const selection = runtime.selection;
  if (!selection || selection.kind === "fake") return undefined;
  return selection.apiKey;
}

export function redact(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[redacted]");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "model request failed";
}

interface ChatChoice {
  finish_reason?: string;
  message?: {
    content?: unknown;
    tool_calls?: {
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  };
}

function firstChoice(parsed: unknown): ChatChoice | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return undefined;
  const choice = parsed.choices[0];
  return isRecord(choice) ? (choice as ChatChoice) : undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

function toOpenAiMessages(messages: readonly unknown[]): {
  role: string;
  content?: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
}[] {
  const converted: ReturnType<typeof toOpenAiMessages> = [];
  for (const message of messages) {
    if (!isRecord(message) || typeof message.role !== "string") continue;
    if (message.role === "system" || message.role === "user") {
      converted.push({
        role: message.role,
        content: contentText(message.content),
      });
      continue;
    }
    if (message.role === "assistant") {
      const text = contentText(message.content);
      const toolCalls = toolCallsFrom(message.content);
      converted.push({
        role: "assistant",
        ...(text ? { content: text } : { content: "" }),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (message.role === "toolResult") {
      converted.push({
        role: "tool",
        tool_call_id:
          typeof message.toolCallId === "string" ? message.toolCallId : "",
        content: contentText(message.content),
      });
    }
  }
  return converted;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string")
        return part.text;
      if (part.type === "image") return "[image omitted]";
      return "";
    })
    .join("");
}

function toolCallsFrom(content: unknown): {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}[] {
  if (!Array.isArray(content)) return [];
  const calls = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "toolCall") continue;
    if (typeof part.name !== "string" || typeof part.id !== "string") continue;
    calls.push({
      id: part.id,
      type: "function" as const,
      function: {
        name: part.name,
        arguments: JSON.stringify(part.arguments ?? {}),
      },
    });
  }
  return calls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
