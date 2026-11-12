import { stream as piStream } from "@earendil-works/pi-ai/api/openai-completions";
import type {
  AssistantMessage,
  JsonObject,
  Model,
  StopReason,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { estimateTokens, type AgentLimits } from "./limits.js";

/**
 * Pinned loop library. Model transcripts go through Pi's
 * OpenAI-completions transport with November's endpoint, credential,
 * retry, output-limit, and identity configuration. Attribution for the
 * loop itself is in NOTICE.
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

const MODEL_ID_MAX_LENGTH = 256;

/** Internal stand-in so the SDK accepts a keyless local endpoint. Never sent. */
const KEYLESS_PLACEHOLDER_KEY = "november-local-no-key";

export const NOVEMBER_IDENTITY = {
  userAgent: { custom: "november" },
  attribution: { name: "november", url: "https://www.november.bot/" },
} as const;

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

export type TokenField = "max_tokens" | "max_completion_tokens";

export type ProviderSelection =
  | { readonly kind: "fake"; readonly script: readonly FakeStep[] }
  | {
      readonly kind: "hosted-openai";
      /**
       * API base including its version prefix, for example
       * https://api.openai.com/v1. The transport appends /chat/completions.
       */
      readonly baseUrl: string;
      readonly model: string;
      readonly apiKey: string;
      /** Token-limit field. Defaults to Pi's per-endpoint detection. */
      readonly tokenField?: TokenField;
      /** Fetch implementation. Defaults to global fetch. */
      readonly fetch?: typeof fetch;
    }
  | {
      readonly kind: "local-openai";
      /** API base including its version prefix. See hosted-openai. */
      readonly baseUrl: string;
      readonly model: string;
      readonly apiKey?: string;
      /**
       * Token-limit field. Defaults to max_tokens for older local
       * servers; select max_completion_tokens when the endpoint documents it.
       */
      readonly tokenField?: TokenField;
      /** Fetch implementation. Defaults to global fetch. */
      readonly fetch?: typeof fetch;
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
  // The application budget, not a model window: November uses Pi's full
  // stream(), which never applies context-window margin math.
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
    ...(selection.kind === "fake"
      ? {}
      : {
          compat: {
            maxTokensField:
              selection.tokenField ??
              (selection.kind === "local-openai"
                ? "max_tokens"
                : ("max_completion_tokens" as const)),
          },
        }),
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
  if (
    typeof selection.model !== "string" ||
    selection.model.length === 0 ||
    selection.model.length > MODEL_ID_MAX_LENGTH
  ) {
    throw new Error(
      `model id must be a nonempty string of at most ${MODEL_ID_MAX_LENGTH} characters`,
    );
  }
  if (
    selection.tokenField !== undefined &&
    selection.tokenField !== "max_tokens" &&
    selection.tokenField !== "max_completion_tokens"
  ) {
    throw new Error("token field must be max_tokens or max_completion_tokens");
  }
  if (selection.fetch !== undefined && typeof selection.fetch !== "function") {
    throw new Error("provider fetch must be a function");
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
): StreamFn {
  return (model, context, options) => {
    const messages = context.messages;
    runtime.requestMessageCounts.push(messages.length);
    runtime.requestTokens.push(estimateTokens(messages));
    const selection = runtime.selection;
    if (!selection || selection.kind === "fake") {
      return runFake(model, options?.signal, runtime, limits, selection);
    }
    return runPiStream(model, context, options, selection, limits);
  };
}

function runPiStream(
  model: Model<string>,
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  selection: Extract<
    ProviderSelection,
    { kind: "hosted-openai" | "local-openai" }
  >,
  limits: AgentLimits,
): AssistantMessageEventStream {
  const userSignal = options?.signal;
  const keyless = selection.kind === "local-openai" && !selection.apiKey;
  const apiKey = selection.apiKey ?? KEYLESS_PLACEHOLDER_KEY;
  // Pi's SDK timeout clears after response headers, so an explicit
  // deadline covers the whole stream including the response body.
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, limits.requestTimeoutMs);
  const combined =
    userSignal != null
      ? AbortSignal.any([userSignal, deadline.signal])
      : deadline.signal;
  // November only ever selects openai-completions models (see modelFor).
  const openAiModel = model as Model<"openai-completions">;
  let inner: AssistantMessageEventStream;
  try {
    inner = piStream(openAiModel, context, {
      signal: combined,
      apiKey,
      fetch: createGuardedFetch(
        {
          keyless,
          maxResponseBytes: limits.maxResponseBytes,
        },
        selection.fetch,
      ),
      headers: options?.headers,
      identity: options?.identity ?? NOVEMBER_IDENTITY,
      timeoutMs: limits.requestTimeoutMs,
      maxRetries: limits.maxRetries,
      maxRetryDelayMs: limits.maxRetryDelayMs,
      maxTokens: limits.maxOutputTokens,
      temperature: options?.temperature,
      samplingParams: options?.samplingParams,
    });
  } catch (error) {
    clearTimeout(timer);
    const failed = new AssistantMessageEventStream();
    pushError(
      failed,
      model,
      redact(errorText(error), keyless ? undefined : apiKey),
    );
    return failed;
  }
  const outer = new AssistantMessageEventStream();
  const secret = keyless ? undefined : selection.apiKey;
  void forwardWithTimeout(inner, outer, {
    timer,
    timedOut: () => timedOut && (userSignal == null || !userSignal.aborted),
    secret,
  });
  return outer;
}

async function forwardWithTimeout(
  inner: AssistantMessageEventStream,
  outer: AssistantMessageEventStream,
  options: {
    timer: ReturnType<typeof setTimeout>;
    timedOut: () => boolean;
    secret: string | undefined;
  },
): Promise<void> {
  try {
    try {
      for await (const event of inner) {
        if (event.type === "error" && options.timedOut()) {
          outer.push({
            type: "error",
            reason: "error",
            error: timeoutMessage(event.error),
          });
          continue;
        }
        if (event.type === "error" && options.secret) {
          outer.push({
            ...event,
            error: {
              ...event.error,
              errorMessage: event.error.errorMessage
                ? redact(event.error.errorMessage, options.secret)
                : undefined,
            },
          });
          continue;
        }
        outer.push(event);
      }
    } catch (error) {
      outer.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "november",
          model: "november",
          usage: EMPTY_USAGE,
          stopReason: "error",
          errorMessage: options.secret
            ? redact(errorText(error), options.secret)
            : errorText(error),
          timestamp: Date.now(),
        },
      });
    }
  } finally {
    clearTimeout(options.timer);
  }
}

function timeoutMessage(error: AssistantMessage): AssistantMessage {
  return {
    ...error,
    stopReason: "error",
    errorMessage: "model request timed out",
  };
}

/**
 * Fetch wrapper for provider requests: redirects are refused, a keyless
 * local mode sends no authorization header, and response bodies are
 * capped so one reply cannot allocate without bound.
 */
export function createGuardedFetch(
  options: {
    keyless: boolean;
    maxResponseBytes: number;
  },
  impl: typeof fetch = fetch,
): typeof fetch {
  return (async (input, init) => {
    const headers = new Headers(init?.headers);
    if (options.keyless) headers.delete("authorization");
    const response = await impl(input, {
      ...init,
      headers,
      redirect: "error",
    });
    if (!response.body) return response;
    let total = 0;
    const cap = options.maxResponseBytes;
    const capped = response.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > cap) {
            controller.error(new Error("model response exceeded the byte cap"));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(capped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

function runFake(
  model: Model<string>,
  signal: AbortSignal | undefined,
  runtime: ProviderRuntime,
  limits: AgentLimits,
  selection: ProviderSelection | undefined,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  void fulfillFake(stream, model, signal, runtime, limits, selection).catch(
    (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "model request failed";
      pushError(stream, model, message);
    },
  );
  return stream;
}

async function fulfillFake(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  signal: AbortSignal | undefined,
  runtime: ProviderRuntime,
  limits: AgentLimits,
  selection: ProviderSelection | undefined,
): Promise<void> {
  if (!selection || selection.kind !== "fake") {
    pushError(stream, model, "no provider selected");
    return;
  }
  const step = selection.script[runtime.scriptIndex];
  runtime.scriptIndex += 1;
  if (!step) {
    pushMessage(stream, model, "(no fixture response)", "stop", limits);
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
    pushMessage(stream, model, step.text, "stop", limits);
    return;
  }
  if (step.type === "malformed-tool") {
    pushTool(stream, model, {
      ...fauxToolCall(step.name, {}, { id: step.id ?? "call-malformed" }),
      argumentsError: `malformed tool arguments: ${step.raw.slice(0, 200)}`,
    });
    return;
  }
  pushTool(
    stream,
    model,
    fauxToolCall(step.name, step.arguments as JsonObject, {
      id: step.id ?? "call-fixture",
    }),
  );
}

function pushMessage(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  text: string,
  reason: Extract<StopReason, "stop" | "length">,
  limits: AgentLimits,
): void {
  let output = text;
  let stop: Extract<StopReason, "stop" | "length"> = reason;
  const cap = limits.maxOutputTokens * 4;
  if (output.length > cap) {
    output = output.slice(0, cap);
    stop = "length";
  }
  const message = {
    ...fauxAssistantMessage(fauxText(output), { stopReason: stop }),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
  };
  stream.push({ type: "start", partial: fauxPartial(model) });
  stream.push({ type: "done", reason: stop, message });
}

function pushTool(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  toolCall: ToolCall,
): void {
  const message = {
    ...fauxAssistantMessage(toolCall, { stopReason: "toolUse" }),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
  };
  stream.push({ type: "start", partial: fauxPartial(model) });
  stream.push({ type: "done", reason: "toolUse", message });
}

function pushError(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  message: string,
  reason: "error" | "aborted" = "error",
): void {
  const error = {
    ...fauxAssistantMessage([], {
      stopReason: reason,
      errorMessage: message,
    }),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
  };
  stream.push({ type: "error", reason, error });
}

function fauxPartial(model: Model<string>): AssistantMessage {
  return {
    ...fauxAssistantMessage([], { stopReason: "stop" }),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
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

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export function redact(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[redacted]");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "model request failed";
}
