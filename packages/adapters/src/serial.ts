/**
 * Versioned serial frames for the board link (issue #12).
 *
 * Frames are length-prefixed JSON, at most MAX_FRAME_BYTES. Opening sends a
 * hello carrying a fresh challenge; the board must answer with a distinct
 * hello-reply echoing that challenge and reporting its own identity.
 * Reflections of our hello and stale replies never satisfy the handshake,
 * and a conflicting identity after open invalidates the link.
 *
 * A fatal framing error (an out-of-bounds length) or a possibly partial
 * write ends the session: pending commands settle as unknown, the pipe
 * closes, and later commands are rejected without writing. Recoverable
 * malformed bodies are reported and ignored; they never clear pending
 * work. Only validated result messages settle commands.
 *
 * Each command goes on the wire under a fresh link-issued id, so a late
 * reply for a retired request can never confirm a newer operation that
 * reuses the caller's id. Reusing a caller's id while it is still in
 * flight is rejected. Durable command identity and replay rules belong to
 * the action journal (#10), not to this transport.
 *
 * Refusals before any byte leaves (closed link, invalid input, oversize
 * frame) are rejected; only failures where bytes may have left are
 * unknown. Timeouts are caller-supplied milliseconds.
 *
 * The 1024-byte JSON limit bounds one frame, not all link memory: chunk
 * sizes and outstanding-command counts still need transport bounds at
 * integration (#11/#12). The real port, pseudo-terminal failures, and
 * reference-firmware verification remain outstanding (#12).
 */
import { randomBytes } from "node:crypto";

export const SERIAL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface SerialMessage {
  readonly v: 1;
  readonly id: string;
  readonly type: "hello" | "hello-reply" | "command" | "result";
  readonly identity?: string;
  readonly op?: string;
  readonly payload?: boolean | number | null;
  readonly outcome?: "confirmed" | "failed" | "unknown";
  readonly detail?: string;
}

export interface BytePipe {
  write(chunk: Buffer): void;
  onData(listener: (chunk: Buffer) => void): void;
  close(): void;
}

export interface SerialResult {
  readonly outcome: "confirmed" | "failed" | "unknown" | "rejected";
  readonly detail: string;
}

function rejected(detail: string): SerialResult {
  return { outcome: "rejected", detail };
}

export function encodeFrame(message: SerialMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`serial frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function createFrameParser(
  onMessage: (message: SerialMessage) => void,
  onError: (detail: string, fatal: boolean) => void,
) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  return {
    push(chunk: Buffer) {
      if (failed) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length < 2 || length > MAX_FRAME_BYTES) {
          failed = true;
          buffer = Buffer.alloc(0);
          onError("serial frame length is out of bounds", true);
          return;
        }
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8")) as unknown;
        } catch {
          onError("serial frame was not JSON", false);
          continue;
        }
        if (!isMessage(parsed)) {
          onError("serial frame fields were rejected", false);
          continue;
        }
        onMessage(parsed);
      }
    },
  };
}

export interface SerialLink {
  readonly writes: number;
  command(
    id: string,
    op: string,
    payload: boolean | number | null,
    timeoutMs: number,
  ): Promise<SerialResult>;
  close(): void;
}

interface PendingEntry {
  readonly callerId: string;
  readonly resolve: (result: SerialResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function closeQuietly(pipe: BytePipe): void {
  try {
    pipe.close();
  } catch {
    // Local state is settled independently of transport cleanup.
  }
}

export async function openSerialLink(
  pipe: BytePipe,
  options: {
    readonly identity: string;
    readonly helloTimeoutMs?: number;
    readonly onFrameError?: (detail: string) => void;
  },
): Promise<SerialLink | SerialResult> {
  const helloTimeoutMs = options.helloTimeoutMs ?? 50;
  if (
    !Number.isFinite(helloTimeoutMs) ||
    helloTimeoutMs < 1 ||
    helloTimeoutMs > MAX_TIMEOUT_MS
  ) {
    return rejected("invalid hello timeout");
  }
  if (typeof options.identity !== "string" || options.identity.length === 0) {
    return rejected("board identity is required");
  }
  const challenge = randomBytes(16).toString("hex");
  const pending = new Map<string, PendingEntry>();
  const inFlightIds = new Set<string>();
  let writes = 0;
  let dead = false;
  let deadDetail = "link is closed";
  let nextWire = 1;
  let helloDone = false;
  let helloOk = false;
  let helloDetail = "board did not answer hello";
  let finishHello: () => void = () => undefined;

  const failLink = (detail: string): void => {
    if (dead) return;
    dead = true;
    deadDetail = detail;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ outcome: "unknown", detail });
    }
    pending.clear();
    inFlightIds.clear();
    closeQuietly(pipe);
    if (!helloDone) {
      helloDone = true;
      helloDetail = detail;
      finishHello();
    }
  };

  const parser = createFrameParser(
    (message) => {
      if (dead) return;
      if (!helloDone) {
        // Only a correlated reply counts; reflections and stale replies
        // are ignored while the handshake waits.
        if (message.type !== "hello-reply" || message.id !== challenge) return;
        if (
          typeof message.identity !== "string" ||
          message.identity !== options.identity
        ) {
          if (typeof message.identity === "string") {
            helloDone = true;
            helloOk = false;
            helloDetail = "board identity did not match";
            finishHello();
          }
          return;
        }
        helloDone = true;
        helloOk = true;
        finishHello();
        return;
      }
      if (message.type === "hello" || message.type === "hello-reply") {
        if (
          typeof message.identity === "string" &&
          message.identity !== options.identity
        ) {
          failLink("board identity changed");
        }
        return;
      }
      if (message.type !== "result") return;
      const result = toResult(message);
      if (!result) {
        options.onFrameError?.("serial result fields were rejected");
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      inFlightIds.delete(entry.callerId);
      clearTimeout(entry.timer);
      entry.resolve(result);
    },
    (detail, fatal) => {
      if (fatal) {
        failLink(detail);
        return;
      }
      options.onFrameError?.(detail);
    },
  );

  try {
    pipe.onData((chunk) => parser.push(chunk));
  } catch {
    return rejected("port listener failed");
  }
  const helloSettled = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (!helloDone) {
        helloDone = true;
        helloDetail = "board did not answer hello";
      }
      resolve(helloOk);
    }, helloTimeoutMs);
    finishHello = () => {
      clearTimeout(timer);
      resolve(helloOk);
    };
  });
  let helloFrame: Buffer;
  try {
    helloFrame = encodeFrame({
      v: SERIAL_VERSION,
      id: challenge,
      type: "hello",
      identity: options.identity,
    });
  } catch {
    closeQuietly(pipe);
    clearHelloTimer();
    return rejected(`serial frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  try {
    pipe.write(helloFrame);
    writes += 1;
  } catch {
    closeQuietly(pipe);
    // The waiter below can no longer succeed; settle it promptly.
    helloDone = true;
    helloDetail = "hello write failed";
    finishHello();
    return rejected("hello write failed");
  }
  if (!(await helloSettled) || dead) {
    const detail = dead ? deadDetail : helloDetail;
    failLink(detail);
    return rejected(detail);
  }
  return {
    get writes() {
      return writes;
    },
    command(id, op, payload, timeoutMs) {
      if (typeof id !== "string" || id.length === 0) {
        return Promise.resolve(rejected("command id is required"));
      }
      if (id.length > MAX_FRAME_BYTES) {
        return Promise.resolve(rejected("command id is too long"));
      }
      if (typeof op !== "string" || op.length === 0) {
        return Promise.resolve(rejected("command op is required"));
      }
      if (
        typeof payload !== "boolean" &&
        typeof payload !== "number" &&
        payload !== null
      ) {
        return Promise.resolve(
          rejected("payload must be boolean, number, or null"),
        );
      }
      if (typeof payload === "number" && !Number.isFinite(payload)) {
        return Promise.resolve(rejected("payload must be finite"));
      }
      if (
        !Number.isFinite(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > MAX_TIMEOUT_MS
      ) {
        return Promise.resolve(rejected("invalid command timeout"));
      }
      if (dead) return Promise.resolve(rejected(deadDetail));
      const wireId = String(nextWire);
      let frame: Buffer;
      try {
        frame = encodeFrame({
          v: SERIAL_VERSION,
          id: wireId,
          type: "command",
          op,
          payload,
        });
      } catch {
        return Promise.resolve(
          rejected(`serial frame exceeds ${MAX_FRAME_BYTES} bytes`),
        );
      }
      if (inFlightIds.has(id)) {
        return Promise.resolve(rejected("command id is already in flight"));
      }
      nextWire += 1;
      return new Promise<SerialResult>((resolve) => {
        const timer = setTimeout(() => {
          const entry = pending.get(wireId);
          if (!entry) return;
          pending.delete(wireId);
          inFlightIds.delete(entry.callerId);
          resolve({
            outcome: "unknown",
            detail: "reply missing; command was not retried",
          });
        }, timeoutMs);
        pending.set(wireId, {
          callerId: id,
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          timer,
        });
        inFlightIds.add(id);
        try {
          pipe.write(frame);
          writes += 1;
        } catch {
          // Bytes may have left: the framing boundary is lost, so the
          // whole link is terminal, not just this command.
          failLink("command write failed");
        }
      });
    },
    close() {
      if (dead) return;
      failLink("port closed");
    },
  };

  function clearHelloTimer(): void {
    helloDone = true;
    finishHello();
  }
}

function toResult(message: SerialMessage): SerialResult | undefined {
  if (
    message.outcome !== "confirmed" &&
    message.outcome !== "failed" &&
    message.outcome !== "unknown"
  ) {
    return undefined;
  }
  if (message.detail !== undefined && typeof message.detail !== "string") {
    return undefined;
  }
  return { outcome: message.outcome, detail: message.detail ?? "board result" };
}

function isMessage(value: unknown): value is SerialMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<SerialMessage>;
  return (
    message.v === SERIAL_VERSION &&
    typeof message.id === "string" &&
    (message.type === "hello" ||
      message.type === "hello-reply" ||
      message.type === "command" ||
      message.type === "result")
  );
}
