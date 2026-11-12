import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { ActionOutcome } from "@november/core";
import { type AgentLimits } from "./limits.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const READ_CAP_BYTES = 1024 * 1024;

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export interface HardwareRequest {
  readonly commandId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly payload: unknown;
  readonly deadlineMs: number;
}

export interface ExecutionReply {
  readonly outcome: ActionOutcome;
  readonly detail: string;
}

export interface SubmittedAction {
  readonly request: HardwareRequest;
  /** Starts unknown at reservation; replaced when the reply arrives. */
  reply: ExecutionReply;
}

export type StoredMessage =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly toolCalls: readonly {
        readonly id: string;
        readonly name: string;
        readonly arguments: Readonly<Record<string, unknown>>;
      }[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly text: string;
      readonly isError: boolean;
    };

export interface SessionState {
  readonly version: 1;
  readonly projectId: string;
  readonly deviceId: string;
  messages: StoredMessage[];
  /** Command ids already handed to the execution service. Never trimmed. */
  submitted: SubmittedAction[];
}

export function assertScopeId(label: string, value: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new SessionError(
      `${label} must match ${ID_PATTERN.source} so a session path cannot escape its directory`,
    );
  }
}

export function emptySession(
  projectId: string,
  deviceId: string,
): SessionState {
  return {
    version: 1,
    projectId,
    deviceId,
    messages: [],
    submitted: [],
  };
}

/**
 * One JSON file per project and device. Messages are trimmed to the byte and
 * count caps. Submitted command ids are kept even when that makes the file
 * larger than the message budget: forgetting an id would let a restart
 * submit the same physical action again. Saving fails instead.
 */
export class SessionStore {
  readonly filePath: string;

  constructor(
    directory: string,
    projectId: string,
    deviceId: string,
    private readonly limits: AgentLimits,
  ) {
    assertScopeId("projectId", projectId);
    assertScopeId("deviceId", deviceId);
    this.filePath = path.join(directory, projectId, `${deviceId}.json`);
  }

  load(): SessionState {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        const parent = path.dirname(this.filePath);
        const projectId = path.basename(parent);
        const deviceId = path.basename(this.filePath, ".json");
        return emptySession(projectId, deviceId);
      }
      throw new SessionError("session file could not be read");
    }
    if (Buffer.byteLength(raw) > READ_CAP_BYTES) {
      throw new SessionError("session file exceeds the read cap");
    }
    return parseSession(raw, this.filePath);
  }

  save(state: SessionState): void {
    const trimmed = trimMessages(state, this.limits);
    const body = `${JSON.stringify(trimmed)}\n`;
    if (Buffer.byteLength(body) > this.limits.maxSessionBytes) {
      throw new SessionError(
        "session exceeds its byte cap and command ids cannot be discarded to make room",
      );
    }
    persistFile(this.filePath, body);
  }
}

/**
 * Trim whole conversation groups oldest-first: a tool result always stays
 * with the assistant message that requested it. Byte pressure is measured
 * in UTF-8 bytes of the serialized state, so non-ASCII text cannot defeat
 * the budget. At least one group is kept; the command record is separate
 * and is never trimmed.
 */
export function trimMessages(
  state: SessionState,
  limits: AgentLimits,
): SessionState {
  const groups = groupStored(state.messages);
  const kept = [...groups];
  const overCount = () => kept.flat().length > limits.maxSessionMessages;
  const overBytes = () =>
    Buffer.byteLength(JSON.stringify({ ...state, messages: kept.flat() })) >
    limits.maxSessionBytes;
  while (kept.length > 1 && (overCount() || overBytes())) {
    kept.shift();
  }
  return { ...state, messages: kept.flat() };
}

function groupStored(messages: readonly StoredMessage[]): StoredMessage[][] {
  const groups: StoredMessage[][] = [];
  for (const message of messages) {
    const previous = groups[groups.length - 1];
    if (message.role === "tool" && previous) {
      previous.push(message);
      continue;
    }
    groups.push([message]);
  }
  return groups;
}

function persistFile(filePath: string, body: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, filePath);
  const dirFd = openSync(directory, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function parseSession(raw: string, filePath: string): SessionState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SessionError("session file is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new SessionError("session file has an unsupported version");
  }
  const projectId = path.basename(path.dirname(filePath));
  const deviceId = path.basename(filePath, ".json");
  if (parsed.projectId !== projectId || parsed.deviceId !== deviceId) {
    throw new SessionError("session file identity does not match its path");
  }
  if (!Array.isArray(parsed.messages) || !Array.isArray(parsed.submitted)) {
    throw new SessionError(
      "session file is missing messages or submitted actions",
    );
  }
  const messages = parsed.messages.map(parseMessage);
  const submitted = parsed.submitted.map(parseSubmitted);
  return {
    version: 1,
    projectId,
    deviceId,
    messages,
    submitted,
  };
}

function parseMessage(value: unknown): StoredMessage {
  if (!isRecord(value) || typeof value.role !== "string") {
    throw new SessionError("session message is malformed");
  }
  if (value.role === "user" && typeof value.text === "string") {
    return { role: "user", text: value.text };
  }
  if (value.role === "assistant" && typeof value.text === "string") {
    const toolCalls = Array.isArray(value.toolCalls)
      ? value.toolCalls.map(parseToolCall)
      : [];
    return { role: "assistant", text: value.text, toolCalls };
  }
  if (
    value.role === "tool" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    typeof value.text === "string" &&
    typeof value.isError === "boolean"
  ) {
    return {
      role: "tool",
      toolCallId: value.toolCallId,
      toolName: value.toolName,
      text: value.text,
      isError: value.isError,
    };
  }
  throw new SessionError("session message is malformed");
}

function parseToolCall(value: unknown): {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isRecord(value.arguments)
  ) {
    throw new SessionError("session tool call is malformed");
  }
  return {
    id: value.id,
    name: value.name,
    arguments: value.arguments,
  };
}

function parseSubmitted(value: unknown): SubmittedAction {
  if (!isRecord(value) || !isRecord(value.request) || !isRecord(value.reply)) {
    throw new SessionError("session action record is malformed");
  }
  const request = value.request;
  const reply = value.reply;
  if (
    typeof request.commandId !== "string" ||
    typeof request.deviceId !== "string" ||
    typeof request.operation !== "string" ||
    typeof request.deadlineMs !== "number" ||
    typeof reply.outcome !== "string" ||
    typeof reply.detail !== "string"
  ) {
    throw new SessionError("session action record is malformed");
  }
  return {
    request: {
      commandId: request.commandId,
      deviceId: request.deviceId,
      operation: request.operation,
      payload: request.payload ?? null,
      deadlineMs: request.deadlineMs,
    },
    reply: {
      outcome: reply.outcome as ActionOutcome,
      detail: reply.detail,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
