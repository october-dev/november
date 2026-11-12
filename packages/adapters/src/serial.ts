/**
 * Versioned serial frames for the board link (issue #12).
 *
 * Frames are length-prefixed JSON, at most 1024 bytes. The stable identity
 * in the hello is what selects the board. A path is not authority. A missing
 * result is `unknown` and is not written again by itself.
 */
export const SERIAL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024;

export interface SerialMessage {
  readonly v: 1;
  readonly id: string;
  readonly type: "hello" | "command" | "result";
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

export function encodeFrame(message: SerialMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error("serial frame exceeds 1024 bytes");
  }
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function createFrameParser(
  onMessage: (message: SerialMessage) => void,
  onError: (detail: string) => void,
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
          onError("serial frame length is out of bounds");
          return;
        }
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8")) as unknown;
        } catch {
          onError("serial frame was not JSON");
          continue;
        }
        if (!isMessage(parsed)) {
          onError("serial frame fields were rejected");
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

export async function openSerialLink(
  pipe: BytePipe,
  options: { readonly identity: string; readonly helloTimeoutMs?: number },
): Promise<SerialLink | SerialResult> {
  const pending = new Map<string, (result: SerialResult) => void>();
  let writes = 0;
  let closed = false;
  let identified = false;
  const parser = createFrameParser(
    (message) => {
      if (message.type === "hello") {
        identified = message.identity === options.identity;
        return;
      }
      const resolve = pending.get(message.id);
      if (!resolve) return;
      pending.delete(message.id);
      resolve({
        outcome: message.outcome ?? "unknown",
        detail: message.detail ?? "board result",
      });
    },
    () => {
      for (const resolve of pending.values()) {
        resolve({ outcome: "unknown", detail: "malformed serial input" });
      }
      pending.clear();
    },
  );
  pipe.onData((chunk) => parser.push(chunk));
  try {
    writeMessage(pipe, {
      v: 1,
      id: "hello",
      type: "hello",
      identity: options.identity,
    });
    writes += 1;
  } catch {
    return { outcome: "unknown", detail: "hello write failed" };
  }
  const hello = await waitFor(() => identified, options.helloTimeoutMs ?? 50);
  if (!hello) {
    pipe.close();
    return { outcome: "rejected", detail: "board identity did not match" };
  }
  return {
    get writes() {
      return writes;
    },
    command(id, op, payload, timeoutMs) {
      if (closed)
        return Promise.resolve({
          outcome: "unknown",
          detail: "port is closed",
        });
      return new Promise((resolve) => {
        pending.set(id, resolve);
        try {
          writeMessage(pipe, { v: 1, id, type: "command", op, payload });
          writes += 1;
        } catch {
          pending.delete(id);
          resolve({
            outcome: "unknown",
            detail: "partial write; command was not retried",
          });
          return;
        }
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          resolve({
            outcome: "unknown",
            detail: "reply missing; command was not retried",
          });
        }, timeoutMs);
        const original = pending.get(id);
        if (original) {
          pending.set(id, (result) => {
            clearTimeout(timer);
            original(result);
          });
        }
      });
    },
    close() {
      closed = true;
      pipe.close();
      for (const resolve of pending.values()) {
        resolve({ outcome: "unknown", detail: "port closed" });
      }
      pending.clear();
    },
  };
}

function writeMessage(pipe: BytePipe, message: SerialMessage): void {
  pipe.write(encodeFrame(message));
}

function waitFor(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 5);
  });
}

function isMessage(value: unknown): value is SerialMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<SerialMessage>;
  return (
    message.v === 1 &&
    typeof message.id === "string" &&
    (message.type === "hello" ||
      message.type === "command" ||
      message.type === "result")
  );
}
