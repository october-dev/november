import { describe, expect, it, vi } from "vitest";
import {
  createFrameParser,
  encodeFrame,
  openSerialLink,
  type BytePipe,
  type SerialLink,
  type SerialMessage,
  type SerialResult,
} from "./serial.js";

const IDENTITY = "usb-serial:ABC123";

function linkedPipes(): {
  host: BytePipe;
  board: BytePipe;
  hostWrites: Buffer[];
  deliverToHost: (chunk: Buffer) => void;
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
  return {
    host,
    board,
    hostWrites,
    deliverToHost: (chunk) => toHost?.(chunk),
  };
}

function simulatedBoard(
  board: BytePipe,
  options: {
    identity: string;
    reply?: (wireId: string) => SerialMessage;
    delayMs?: number;
  },
): void {
  const parser = createFrameParser(
    (message) => {
      if (message.type === "hello") {
        board.write(
          encodeFrame({
            v: 1,
            id: message.id,
            type: "hello-reply",
            identity: options.identity,
          }),
        );
        return;
      }
      if (message.type !== "command" || !options.reply) return;
      const frame = encodeFrame(options.reply(message.id));
      if (!options.delayMs) {
        board.write(frame);
      } else {
        setTimeout(() => board.write(frame), options.delayMs);
      }
    },
    () => undefined,
  );
  board.onData((chunk) => parser.push(chunk));
}

function confirmedResult(wireId: string): SerialMessage {
  return { v: 1, id: wireId, type: "result", outcome: "confirmed" };
}

function decodeFrame(frame: Buffer): SerialMessage {
  const length = frame.readUInt32BE(0);
  return JSON.parse(
    frame.subarray(4, 4 + length).toString("utf8"),
  ) as SerialMessage;
}

function mustLink(opened: SerialLink | SerialResult): SerialLink {
  if (!("command" in opened)) {
    throw new Error(`expected a link: ${JSON.stringify(opened)}`);
  }
  return opened;
}

function mustResult(opened: SerialLink | SerialResult): SerialResult {
  if ("command" in opened) throw new Error("expected a result, got a link");
  return opened;
}

describe("serial frames", () => {
  it("reassembles a frame that arrives one byte at a time and kills the parser on an oversize length", () => {
    const messages: SerialMessage[] = [];
    const errors: Array<{ detail: string; fatal: boolean }> = [];
    const parser = createFrameParser(
      (message) => messages.push(message),
      (detail, fatal) => errors.push({ detail, fatal }),
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
    expect(errors[0]).toMatchObject({ fatal: true });
    expect(errors[0]?.detail).toMatch(/out of bounds/);
    parser.push(Buffer.from("{"));
    expect(messages).toHaveLength(1);
  });

  it("treats malformed bodies as recoverable and keeps parsing", () => {
    const messages: string[] = [];
    const parser = createFrameParser(
      (message) => messages.push(message.id),
      (detail, fatal) => messages.push(`${detail}:${fatal}`),
    );
    const bad = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("{{{")]);
    parser.push(bad);
    parser.push(
      encodeFrame({ v: 1, id: "cmd-2", type: "result", outcome: "failed" }),
    );
    expect(messages).toContain("serial frame was not JSON:false");
    expect(messages).toContain("cmd-2");
  });

  it("confirms commands with one frame written, on sync and delayed replies", async () => {
    const { host, board, hostWrites } = linkedPipes();
    simulatedBoard(board, { identity: IDENTITY, reply: confirmedResult });
    const link = mustLink(
      await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
    );
    const sync = await link.command("cmd-1", "set", true, 100);
    expect(sync).toMatchObject({ outcome: "confirmed" });
    expect(sync.detail).toEqual(expect.any(String));
    expect(hostWrites).toHaveLength(2);
    expect(link.writes).toBe(2);

    const delayed = linkedPipes();
    simulatedBoard(delayed.board, {
      identity: IDENTITY,
      reply: confirmedResult,
      delayMs: 10,
    });
    const slow = mustLink(
      await openSerialLink(delayed.host, {
        identity: IDENTITY,
        helloTimeoutMs: 40,
      }),
    );
    const result = await slow.command("cmd-1", "set", true, 200);
    expect(result).toMatchObject({ outcome: "confirmed" });
    slow.close();
    link.close();
  });

  it("leaves no timers behind once a reply settles the command", async () => {
    vi.useFakeTimers();
    try {
      const { host, board } = linkedPipes();
      simulatedBoard(board, { identity: IDENTITY, reply: confirmedResult });
      const link = mustLink(
        await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
      );
      const result = await link.command("cmd-1", "set", true, 100);
      expect(result.outcome).toBe("confirmed");
      expect(vi.getTimerCount()).toBe(0);
      link.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a board with a different identity before sending a command", async () => {
    const { host, board, hostWrites } = linkedPipes();
    simulatedBoard(board, { identity: "usb-serial:OTHER" });
    const opened = await openSerialLink(host, {
      identity: IDENTITY,
      helloTimeoutMs: 200,
    });
    expect(mustResult(opened)).toMatchObject({
      outcome: "rejected",
      detail: "board identity did not match",
    });
    expect(hostWrites).toHaveLength(1);
  });

  it("rejects reflections, stale replies, and silence without opening", async () => {
    // Echoing peer: our own hello comes back and must not satisfy the check.
    const echo = linkedPipes();
    echo.board.onData((chunk) => echo.board.write(chunk));
    const reflected = await openSerialLink(echo.host, {
      identity: IDENTITY,
      helloTimeoutMs: 30,
    });
    expect(mustResult(reflected)).toMatchObject({
      outcome: "rejected",
      detail: "board did not answer hello",
    });
    expect(echo.hostWrites).toHaveLength(1);

    // Stale reply: a hello-reply for another challenge is ignored.
    const stale = linkedPipes();
    const staleParser = createFrameParser(
      (message) => {
        if (message.type === "hello") {
          stale.board.write(
            encodeFrame({
              v: 1,
              id: "stale-challenge",
              type: "hello-reply",
              identity: IDENTITY,
            }),
          );
        }
      },
      () => undefined,
    );
    stale.board.onData((chunk) => staleParser.push(chunk));
    const staleOpened = await openSerialLink(stale.host, {
      identity: IDENTITY,
      helloTimeoutMs: 30,
    });
    expect(mustResult(staleOpened)).toMatchObject({
      outcome: "rejected",
      detail: "board did not answer hello",
    });

    // Silent peer.
    const silent = linkedPipes();
    const silentOpened = await openSerialLink(silent.host, {
      identity: IDENTITY,
      helloTimeoutMs: 30,
    });
    expect(mustResult(silentOpened)).toMatchObject({
      outcome: "rejected",
      detail: "board did not answer hello",
    });
  });

  it("invalidates the link when the board identity changes after open", async () => {
    const { host, board, deliverToHost } = linkedPipes();
    simulatedBoard(board, { identity: IDENTITY });
    const link = mustLink(
      await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
    );
    const pending = link.command("cmd-1", "set", true, 500);
    deliverToHost(
      encodeFrame({
        v: 1,
        id: "other-session",
        type: "hello-reply",
        identity: "usb-serial:OTHER",
      }),
    );
    expect(await pending).toMatchObject({ outcome: "unknown" });
    const writes = link.writes;
    expect(await link.command("cmd-2", "set", true, 50)).toMatchObject({
      outcome: "rejected",
    });
    expect(link.writes).toBe(writes);
  });

  it("makes a fatal framing error terminal, during hello and after open", async () => {
    // Fatal error after open: pending work settles unknown, later writes stop.
    const { host, board, deliverToHost } = linkedPipes();
    simulatedBoard(board, { identity: IDENTITY });
    const link = mustLink(
      await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
    );
    const pending = link.command("cmd-1", "set", true, 500);
    const fatal = Buffer.alloc(4);
    fatal.writeUInt32BE(1_000_000, 0);
    deliverToHost(fatal);
    expect(await pending).toMatchObject({ outcome: "unknown" });
    const writes = link.writes;
    expect(await link.command("cmd-2", "set", true, 50)).toMatchObject({
      outcome: "rejected",
    });
    expect(link.writes).toBe(writes);

    // Fatal error after a valid hello but before open resolves: no link.
    const racing = linkedPipes();
    let closed = 0;
    const originalClose = racing.host.close;
    racing.host.close = () => {
      closed += 1;
      originalClose();
    };
    const racingParser = createFrameParser(
      (message) => {
        if (message.type !== "hello") return;
        racing.board.write(
          encodeFrame({
            v: 1,
            id: message.id,
            type: "hello-reply",
            identity: IDENTITY,
          }),
        );
        const bad = Buffer.alloc(4);
        bad.writeUInt32BE(1_000_000, 0);
        racing.board.write(bad);
      },
      () => undefined,
    );
    racing.board.onData((chunk) => racingParser.push(chunk));
    const opened = await openSerialLink(racing.host, {
      identity: IDENTITY,
      helloTimeoutMs: 200,
    });
    expect(mustResult(opened).outcome).toBe("rejected");
    expect(closed).toBe(1);
  });

  it("ignores invalid results and echoed commands without settling the command", async () => {
    const { host, board, hostWrites, deliverToHost } = linkedPipes();
    simulatedBoard(board, { identity: IDENTITY });
    const link = mustLink(
      await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
    );
    const pending = link.command("cmd-1", "set", true, 500);
    const wireId = decodeFrame(hostWrites[1] as Buffer).id;
    deliverToHost(
      encodeFrame({
        v: 1,
        id: wireId,
        type: "result",
        outcome: "done",
        detail: 42,
      } as unknown as SerialMessage),
    );
    deliverToHost(
      encodeFrame({ v: 1, id: wireId, type: "command", op: "set" }),
    );
    deliverToHost(encodeFrame(confirmedResult(wireId)));
    const result = await pending;
    expect(result).toMatchObject({ outcome: "confirmed" });
    expect(result.detail).toEqual(expect.any(String));
    link.close();
  });

  it("keeps pending work across a recoverable malformed frame", async () => {
    const { host, board, hostWrites, deliverToHost } = linkedPipes();
    const frameErrors: string[] = [];
    simulatedBoard(board, { identity: IDENTITY });
    const link = mustLink(
      await openSerialLink(host, {
        identity: IDENTITY,
        helloTimeoutMs: 40,
        onFrameError: (detail) => frameErrors.push(detail),
      }),
    );
    const pending = link.command("cmd-1", "set", true, 500);
    const wireId = decodeFrame(hostWrites[1] as Buffer).id;
    deliverToHost(
      Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("{{{")]),
    );
    expect(frameErrors).toContain("serial frame was not JSON");
    deliverToHost(encodeFrame(confirmedResult(wireId)));
    expect(await pending).toMatchObject({ outcome: "confirmed" });
    link.close();
  });

  it("rejects an in-flight duplicate id before writing, and both callers settle", async () => {
    const { host, board } = linkedPipes();
    simulatedBoard(board, { identity: IDENTITY });
    const link = mustLink(
      await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
    );
    const writes = link.writes;
    const first = link.command("dup", "set", true, 30);
    const second = await link.command("dup", "set", false, 30);
    expect(second).toMatchObject({
      outcome: "rejected",
      detail: "command id is already in flight",
    });
    expect(link.writes).toBe(writes + 1);
    expect(await first).toMatchObject({ outcome: "unknown" });
    link.close();
  });

  it("never lets a late reply confirm a newer operation reusing the id", async () => {
    const { host, board, hostWrites, deliverToHost } = linkedPipes();
    simulatedBoard(board, { identity: IDENTITY });
    const link = mustLink(
      await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
    );
    const first = await link.command("x", "set", true, 20);
    expect(first).toMatchObject({ outcome: "unknown" });
    const second = link.command("x", "set", false, 500);
    const firstWireId = decodeFrame(hostWrites[1] as Buffer).id;
    const secondWireId = decodeFrame(hostWrites[2] as Buffer).id;
    expect(secondWireId).not.toBe(firstWireId);
    deliverToHost(encodeFrame(confirmedResult(firstWireId)));
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    deliverToHost(encodeFrame(confirmedResult(secondWireId)));
    expect(await second).toMatchObject({ outcome: "confirmed" });
    link.close();
  });

  it("never lets a reply from an earlier session settle a command on a new link", async () => {
    const earlier = linkedPipes();
    simulatedBoard(earlier.board, { identity: IDENTITY });
    const old = mustLink(
      await openSerialLink(earlier.host, {
        identity: IDENTITY,
        helloTimeoutMs: 40,
      }),
    );
    expect(await old.command("a", "set", true, 20)).toMatchObject({
      outcome: "unknown",
    });
    const staleWireId = decodeFrame(earlier.hostWrites[1] as Buffer).id;
    old.close();

    const { host, board, hostWrites, deliverToHost } = linkedPipes();
    simulatedBoard(board, { identity: IDENTITY });
    const link = mustLink(
      await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
    );
    const pending = link.command("b", "set", false, 500);
    const wireId = decodeFrame(hostWrites[1] as Buffer).id;
    expect(wireId).not.toBe(staleWireId);
    deliverToHost(encodeFrame(confirmedResult(staleWireId)));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    deliverToHost(encodeFrame(confirmedResult(wireId)));
    expect(await pending).toMatchObject({ outcome: "confirmed" });
    link.close();
  });

  it("does not write a command again when the reply is missing", async () => {
    const { host, board } = linkedPipes();
    simulatedBoard(board, { identity: IDENTITY });
    const link = mustLink(
      await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
    );
    const missing = await link.command("cmd-1", "set", true, 20);
    expect(missing).toMatchObject({ outcome: "unknown" });
    expect(link.writes).toBe(2);
    link.close();
  });

  it("rejects closed-link and oversize commands without writing", async () => {
    const { host, board } = linkedPipes();
    simulatedBoard(board, { identity: IDENTITY, reply: confirmedResult });
    const link = mustLink(
      await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
    );
    const oversize = await link.command("cmd-1", "x".repeat(2000), true, 50);
    expect(oversize.outcome).toBe("rejected");
    expect(oversize.detail).toMatch(/exceeds 1024 bytes/);
    expect(link.writes).toBe(1);
    // A local encoding failure is not terminal: the link still works.
    expect(await link.command("cmd-1", "set", true, 100)).toMatchObject({
      outcome: "confirmed",
    });
    expect(await link.command("", "set", true, 50)).toMatchObject({
      outcome: "rejected",
    });
    expect(await link.command("cmd-2", "set", Number.NaN, 50)).toMatchObject({
      outcome: "rejected",
    });
    expect(await link.command("cmd-2", "set", true, Number.NaN)).toMatchObject({
      outcome: "rejected",
    });
    link.close();
    const writes = link.writes;
    expect(await link.command("cmd-3", "set", true, 50)).toMatchObject({
      outcome: "rejected",
    });
    expect(link.writes).toBe(writes);
  });

  it("closes the pipe on every unsuccessful open", async () => {
    let closed = 0;
    const broken: BytePipe = {
      write() {
        throw new Error("short write");
      },
      onData() {
        return undefined;
      },
      close() {
        closed += 1;
      },
    };
    const failed = await openSerialLink(broken, {
      identity: IDENTITY,
      helloTimeoutMs: 20,
    });
    expect(mustResult(failed)).toMatchObject({
      outcome: "rejected",
      detail: "hello write failed",
    });
    expect(closed).toBe(1);

    const { host } = linkedPipes();
    let helloClosed = 0;
    const originalClose = host.close;
    host.close = () => {
      helloClosed += 1;
      originalClose();
    };
    const oversize = await openSerialLink(host, {
      identity: `usb-serial:${"x".repeat(2000)}`,
      helloTimeoutMs: 20,
    });
    expect(mustResult(oversize).outcome).toBe("rejected");
    expect(helloClosed).toBe(1);
  });

  it("closes the pipe when open is refused before the handshake", async () => {
    const refusals = [
      { identity: "", helloTimeoutMs: 20 },
      { identity: IDENTITY, helloTimeoutMs: Number.NaN },
    ];
    for (const options of refusals) {
      const { host } = linkedPipes();
      let closed = 0;
      host.close = () => {
        closed += 1;
      };
      expect(mustResult(await openSerialLink(host, options)).outcome).toBe(
        "rejected",
      );
      expect(closed).toBe(1);
    }
    const missing = linkedPipes();
    let missingClosed = 0;
    missing.host.close = () => {
      missingClosed += 1;
    };
    expect(
      mustResult(
        await openSerialLink(missing.host, {
          identity: IDENTITY,
        } as Parameters<typeof openSerialLink>[1]),
      ),
    ).toMatchObject({ outcome: "rejected", detail: "invalid hello timeout" });
    expect(missingClosed).toBe(1);
    let closed = 0;
    const deaf: BytePipe = {
      write() {
        return undefined;
      },
      onData() {
        throw new Error("listener failed");
      },
      close() {
        closed += 1;
      },
    };
    expect(
      mustResult(
        await openSerialLink(deaf, { identity: IDENTITY, helloTimeoutMs: 20 }),
      ).outcome,
    ).toBe("rejected");
    expect(closed).toBe(1);
  });

  it("treats a partial command write as a terminal link failure", async () => {
    const { host, board } = linkedPipes();
    simulatedBoard(board, { identity: IDENTITY });
    let commands = 0;
    let closed = 0;
    const originalWrite = host.write;
    const originalClose = host.close;
    host.write = (chunk) => {
      if (commands === 0) {
        // Hello goes through whole.
        commands += 1;
        originalWrite(chunk);
        return;
      }
      commands += 1;
      if (commands === 2) {
        // First command goes through whole; the reply never comes.
        originalWrite(chunk);
        return;
      }
      // Second command delivers a prefix, then fails.
      originalWrite(chunk.subarray(0, 2));
      throw new Error("prefix then failure");
    };
    host.close = () => {
      closed += 1;
      originalClose();
    };
    const link = mustLink(
      await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
    );
    const first = link.command("cmd-1", "set", true, 500);
    const second = await link.command("cmd-2", "set", true, 500);
    expect(second).toMatchObject({ outcome: "unknown" });
    expect(await first).toMatchObject({ outcome: "unknown" });
    expect(closed).toBe(1);
    expect(await link.command("cmd-3", "set", true, 50)).toMatchObject({
      outcome: "rejected",
    });
  });

  it("settles in-flight commands on close, even when close throws", async () => {
    const { host, board } = linkedPipes();
    simulatedBoard(board, { identity: IDENTITY });
    const link = mustLink(
      await openSerialLink(host, { identity: IDENTITY, helloTimeoutMs: 40 }),
    );
    const pending = link.command("cmd-1", "set", true, 500);
    link.close();
    expect(await pending).toMatchObject({
      outcome: "unknown",
      detail: "port closed",
    });
    expect(() => link.close()).not.toThrow();

    const throwing = linkedPipes();
    simulatedBoard(throwing.board, { identity: IDENTITY });
    let closed = 0;
    throwing.host.close = () => {
      closed += 1;
      throw new Error("close failed");
    };
    const fragile = mustLink(
      await openSerialLink(throwing.host, {
        identity: IDENTITY,
        helloTimeoutMs: 40,
      }),
    );
    const fragilePending = fragile.command("cmd-1", "set", true, 500);
    expect(() => fragile.close()).not.toThrow();
    expect(await fragilePending).toMatchObject({ outcome: "unknown" });
    expect(closed).toBe(1);
  });
});
