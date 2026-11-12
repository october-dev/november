import { describe, expect, it } from "vitest";
import {
  createFrameParser,
  encodeFrame,
  openSerialLink,
  type BytePipe,
  type SerialMessage,
} from "./serial.js";

function linkedPipes(): {
  host: BytePipe;
  board: BytePipe;
  hostWrites: Buffer[];
} {
  const hostWrites: Buffer[] = [];
  let toHost: ((chunk: Buffer) => void) | undefined;
  let toBoard: ((chunk: Buffer) => void) | undefined;
  const host: BytePipe = {
    write(chunk) {
      hostWrites.push(chunk);
      toBoard?.(chunk);
    },
    onData(listener) {
      toHost = listener;
    },
    close() {
      toHost = undefined;
    },
  };
  const board: BytePipe = {
    write(chunk) {
      for (const byte of chunk) toHost?.(Buffer.from([byte]));
    },
    onData(listener) {
      toBoard = listener;
    },
    close() {
      toBoard = undefined;
    },
  };
  return { host, board, hostWrites };
}

function answerHello(board: BytePipe, identity: string) {
  const parser = createFrameParser(
    (message) => {
      if (message.type === "hello") {
        board.write(
          encodeFrame({ v: 1, id: "hello", type: "hello", identity }),
        );
      }
    },
    () => undefined,
  );
  board.onData((chunk) => parser.push(chunk));
}

describe("serial frames", () => {
  it("reassembles a frame that arrives one byte at a time and rejects an oversize length", () => {
    const messages: SerialMessage[] = [];
    const errors: string[] = [];
    const parser = createFrameParser(
      (message) => messages.push(message),
      (detail) => errors.push(detail),
    );
    const frame = encodeFrame({
      v: 1,
      id: "cmd-1",
      type: "result",
      outcome: "confirmed",
    });
    for (const byte of frame) parser.push(Buffer.from([byte]));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.outcome).toBe("confirmed");

    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(1_000_000, 0);
    parser.push(huge);
    expect(errors[0]).toMatch(/out of bounds/);
    parser.push(Buffer.from("{"));
    expect(messages).toHaveLength(1);
  });

  it("rejects a board with a different identity before sending a command", async () => {
    const { host, board, hostWrites } = linkedPipes();
    answerHello(board, "usb-serial:OTHER");
    const opened = await openSerialLink(host, {
      identity: "usb-serial:ABC123",
      helloTimeoutMs: 40,
    });
    expect(opened).toMatchObject({ outcome: "rejected" });
    expect(hostWrites).toHaveLength(1);
  });

  it("does not write a command again when the reply is missing or the write fails", async () => {
    const { host, board } = linkedPipes();
    answerHello(board, "usb-serial:ABC123");
    const opened = await openSerialLink(host, {
      identity: "usb-serial:ABC123",
      helloTimeoutMs: 40,
    });
    if (!("command" in opened)) throw new Error("expected a link");
    const missing = await opened.command("cmd-1", "set", true, 20);
    expect(missing).toMatchObject({ outcome: "unknown" });
    expect(opened.writes).toBe(2);
    const broken = await openSerialLink(
      {
        write() {
          throw new Error("short write");
        },
        onData() {
          return undefined;
        },
        close() {
          return undefined;
        },
      },
      { identity: "usb-serial:ABC123", helloTimeoutMs: 20 },
    );
    expect(broken).toMatchObject({
      outcome: "unknown",
      detail: "hello write failed",
    });
  });

  it("treats a malformed frame as unknown and still accepts a later valid result", async () => {
    const messages: string[] = [];
    const parser = createFrameParser(
      (message) => messages.push(message.id),
      (detail) => messages.push(detail),
    );
    const bad = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("{{{")]);
    parser.push(bad);
    parser.push(
      encodeFrame({ v: 1, id: "cmd-2", type: "result", outcome: "failed" }),
    );
    expect(messages).toContain("serial frame was not JSON");
    expect(messages).toContain("cmd-2");
  });
});
