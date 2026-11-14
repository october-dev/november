import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openJournal,
  type EffectOutcome,
  type JournalCommand,
} from "./journal.js";

const owned: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (owned.length > 0) {
    rmSync(owned.pop() as string, { recursive: true, force: true });
  }
});

function file(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "november-journal-"));
  owned.push(directory);
  return path.join(directory, "journal.json");
}

function clock(start = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function command(overrides: Partial<JournalCommand> = {}): JournalCommand {
  return {
    commandId: "cmd-1",
    callerId: "dev",
    deviceId: "host-led",
    operation: "set",
    payload: { on: true },
    policyVersion: 3,
    deadlineMs: 1000,
    ...overrides,
  };
}

function readRecords(journalPath: string): Array<{ [key: string]: unknown }> {
  return JSON.parse(readFileSync(journalPath, "utf8")) as Array<{
    [key: string]: unknown;
  }>;
}

describe("action journal", () => {
  it("admits, dispatches once, and returns the stored outcome on retry", async () => {
    const journalPath = file();
    const journal = openJournal(journalPath, { clock: clock(100).now });
    let applied = 0;
    expect(journal.admit(command())).toMatchObject({ outcome: "queued" });
    const first = await journal.dispatch("cmd-1", "dev", () => {
      applied += 1;
      const saved = readRecords(journalPath).find(
        (record) => record.commandId === "cmd-1",
      );
      expect(saved?.outcome).toBe("dispatched");
      return { outcome: "confirmed" } as const;
    });
    expect(first).toMatchObject({
      outcome: "confirmed",
      effectRan: true,
    });
    expect(applied).toBe(1);
    expect(journal.admit(command())).toMatchObject({
      outcome: "confirmed",
      effectRan: false,
    });
    expect(
      await journal.dispatch("cmd-1", "dev", () => ({ outcome: "confirmed" })),
    ).toMatchObject({ outcome: "confirmed", effectRan: false });
    expect(applied).toBe(1);
    expect(journal.records()).toEqual([
      {
        commandId: "cmd-1",
        deviceId: "host-led",
        operation: "set",
        outcome: "confirmed",
      },
    ]);
    expect(readFileSync(journalPath, "utf8")).toContain("confirmed");
  });

  it("records failed, unknown, thrown, and async effect outcomes without rerunning", async () => {
    const journalPath = file();
    const journal = openJournal(journalPath);
    let runs = 0;
    journal.admit(command({ commandId: "a" }));
    expect(
      await journal.dispatch("a", "dev", () => {
        runs += 1;
        return { outcome: "failed", detail: "valve stuck" };
      }),
    ).toMatchObject({
      outcome: "failed",
      detail: "valve stuck",
      effectRan: true,
    });

    journal.admit(command({ commandId: "b" }));
    expect(
      await journal.dispatch("b", "dev", () => {
        runs += 1;
        return { outcome: "unknown" };
      }),
    ).toMatchObject({ outcome: "unknown", effectRan: true });

    journal.admit(command({ commandId: "c" }));
    expect(
      await journal.dispatch("c", "dev", () => {
        runs += 1;
        throw new Error("lost reply");
      }),
    ).toMatchObject({
      outcome: "unknown",
      detail: "effect failed after dispatch",
      effectRan: true,
    });

    journal.admit(command({ commandId: "d" }));
    expect(
      await journal.dispatch("d", "dev", async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({ outcome: "confirmed", effectRan: true });
    expect(runs).toBe(4);

    expect(
      await journal.dispatch("a", "dev", () => ({ outcome: "confirmed" })),
    ).toMatchObject({ outcome: "failed", effectRan: false });
    expect(runs).toBe(4);

    journal.admit(command({ commandId: "e" }));
    expect(
      await journal.dispatch("e", "dev", () => ({ outcome: "bogus" }) as never),
    ).toMatchObject({
      outcome: "unknown",
      detail: "effect reported an invalid outcome",
    });
  });

  it("rejects dispatch and cancel for unknown ids and other callers", async () => {
    const journal = openJournal(file());
    journal.admit(command());
    expect(
      await journal.dispatch("nope", "dev", () => ({ outcome: "confirmed" })),
    ).toMatchObject({ outcome: "rejected", detail: "unknown command" });
    expect(
      await journal.dispatch("cmd-1", "mallory", () => ({
        outcome: "confirmed",
      })),
    ).toMatchObject({
      outcome: "rejected",
      detail: "caller does not own this command",
    });
    expect(journal.cancel("nope", "dev")).toMatchObject({
      outcome: "rejected",
      detail: "unknown command",
    });
    expect(journal.cancel("cmd-1", "mallory")).toMatchObject({
      outcome: "rejected",
      detail: "caller does not own this command",
    });
  });

  it("cancels only before dispatch and never claims undo", async () => {
    const journal = openJournal(file());
    journal.admit(command());
    expect(journal.cancel("cmd-1", "dev")).toMatchObject({
      outcome: "cancelled-before-dispatch",
    });
    expect(journal.cancel("cmd-1", "dev")).toMatchObject({
      outcome: "cancelled-before-dispatch",
      detail: "already cancelled",
    });
    let applied = 0;
    expect(
      await journal.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({ outcome: "cancelled-before-dispatch", effectRan: false });
    expect(applied).toBe(0);

    journal.admit(command({ commandId: "cmd-2" }));
    await journal.dispatch("cmd-2", "dev", () => ({ outcome: "confirmed" }));
    expect(journal.cancel("cmd-2", "dev").detail).toMatch(/does not undo/);
    expect(
      journal.records().find((record) => record.commandId === "cmd-2")?.outcome,
    ).toBe("confirmed");
  });

  it("expires queued work by its deadline, with the boundary dispatching", async () => {
    const time = clock(0);
    const journal = openJournal(file(), { clock: time.now });
    journal.admit(command({ deadlineMs: 100 }));
    time.advance(100);
    let applied = 0;
    expect(
      await journal.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({ outcome: "confirmed" });
    expect(applied).toBe(1);

    const late = clock(0);
    const expired = openJournal(file(), { clock: late.now });
    expired.admit(command({ deadlineMs: 100 }));
    late.advance(101);
    expect(
      await expired.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({
      outcome: "cancelled-before-dispatch",
      detail: "deadline expired before dispatch",
    });
    expect(applied).toBe(1);
  });

  it("rechecks the deadline after persisting dispatch intent", async () => {
    const journalPath = file();
    const time = clock(0);
    let writes = 0;
    const journal = openJournal(journalPath, {
      clock: time.now,
      write: (target, body) => {
        writes += 1;
        if (writes === 2) time.advance(10_000);
        writeFileSync(target, body);
      },
    });
    journal.admit(command({ deadlineMs: 100 }));
    let applied = 0;
    expect(
      await journal.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({ outcome: "cancelled-before-dispatch" });
    expect(applied).toBe(0);
  });

  it("measures deadlines with the monotonic default clock", async () => {
    const wall = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(100);
    const journal = openJournal(file());
    journal.admit(command({ deadlineMs: 100 }));
    wall.mockReturnValue(9_000);
    monotonic.mockReturnValue(201);
    let applied = 0;
    expect(
      await journal.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({
      outcome: "cancelled-before-dispatch",
      detail: "deadline expired before dispatch",
    });
    expect(applied).toBe(0);
  });

  it("compares every caller-supplied identity field on id reuse", async () => {
    const journal = openJournal(file());
    journal.admit(command());
    await journal.dispatch("cmd-1", "dev", () => ({ outcome: "confirmed" }));
    const variants: Partial<JournalCommand>[] = [
      { callerId: "other" },
      { deviceId: "other-led" },
      { operation: "toggle" },
      { payload: { on: false } },
      { deadlineMs: 2000 },
    ];
    for (const variant of variants) {
      expect(
        journal.admit(command(variant)).detail,
        JSON.stringify(variant),
      ).toBe("command id was already used with different parameters");
    }
    expect(journal.admit(command())).toMatchObject({
      outcome: "confirmed",
      effectRan: false,
    });
  });

  it("returns the stored outcome when only the policy version changed", async () => {
    const journal = openJournal(file());
    const unversioned = command();
    delete (unversioned as { policyVersion?: number }).policyVersion;
    journal.admit(unversioned);
    await journal.dispatch("cmd-1", "dev", () => ({ outcome: "confirmed" }));
    expect(journal.admit(command({ policyVersion: 9 }))).toMatchObject({
      outcome: "confirmed",
      effectRan: false,
    });

    journal.admit(command({ commandId: "cmd-2", policyVersion: 3 }));
    await journal.dispatch("cmd-2", "dev", () => ({ outcome: "confirmed" }));
    const retryUnversioned = command({ commandId: "cmd-2" });
    delete (retryUnversioned as { policyVersion?: number }).policyVersion;
    expect(journal.admit(retryUnversioned)).toMatchObject({
      outcome: "confirmed",
    });
    expect(
      journal.admit(command({ commandId: "cmd-2", policyVersion: 4 })).detail,
    ).toBe("command id was already used with different parameters");
  });

  it("keeps payload equality stable across reopen and rejects unsupported values", async () => {
    const journalPath = file();
    const journal = openJournal(journalPath);
    const payload = { on: true, nested: { x: 1 } };
    journal.admit(command({ payload }));
    payload.nested.x = 999;
    (payload as Record<string, unknown>).extra = true;
    const saved = readRecords(journalPath).find(
      (record) => record.commandId === "cmd-1",
    );
    expect(saved?.payload).toEqual({ on: true, nested: { x: 1 } });
    await journal.dispatch("cmd-1", "dev", () => ({ outcome: "confirmed" }));

    const reopened = openJournal(journalPath);
    expect(reopened.blocked).toBe(false);
    expect(
      reopened.admit(command({ payload: { nested: { x: 1 }, on: true } })),
    ).toMatchObject({ outcome: "confirmed" });

    const protoPayload = JSON.parse(
      '{"__proto__":{"polluted":true},"a":1}',
    ) as Record<string, unknown>;
    reopened.admit(command({ commandId: "proto", payload: protoPayload }));
    await reopened.dispatch("proto", "dev", () => ({ outcome: "confirmed" }));
    const reread = openJournal(journalPath);
    expect(reread.blocked).toBe(false);
    expect(
      reread.admit(command({ commandId: "proto", payload: protoPayload })),
    ).toMatchObject({ outcome: "confirmed" });
    expect(
      reread.admit(command({ commandId: "proto", payload: { a: 1 } })).detail,
    ).toBe("command id was already used with different parameters");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      new Date(0),
      new Map(),
      () => true,
    ]) {
      expect(
        journal.admit(command({ commandId: "bad", payload: bad })).detail,
      ).toBe("command payload is not supported");
    }
  });

  it("answers known ids while blocked and refuses new work", async () => {
    const journalPath = file();
    const healthy = openJournal(journalPath);
    healthy.admit(command());
    await healthy.dispatch("cmd-1", "dev", () => ({ outcome: "confirmed" }));

    const journal = openJournal(journalPath, {
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(journal.blocked).toBe(false);
    expect(journal.admit(command({ commandId: "cmd-2" }))).toMatchObject({
      outcome: "rejected",
      detail: "journal write failed",
    });
    expect(journal.blocked).toBe(true);
    expect(journal.blockedReason).toBe("disk full");
    expect(journal.admit(command())).toMatchObject({
      outcome: "confirmed",
      detail: "journal is unavailable",
    });
    expect(
      await journal.dispatch("cmd-1", "dev", () => ({ outcome: "confirmed" })),
    ).toMatchObject({ outcome: "confirmed", detail: "journal is unavailable" });
    expect(journal.cancel("cmd-1", "dev")).toMatchObject({
      outcome: "confirmed",
      detail: "journal is unavailable",
    });
    expect(journal.admit(command({ commandId: "cmd-3" }))).toMatchObject({
      outcome: "rejected",
      detail: "journal is unavailable; command history could not be checked",
    });
    expect(journal.admit(command({ operation: "toggle" }))).toMatchObject({
      outcome: "rejected",
      detail: "command id was already used with different parameters",
    });
    expect(
      await journal.dispatch("cmd-1", "mallory", () => ({
        outcome: "confirmed",
      })),
    ).toMatchObject({
      outcome: "rejected",
      detail: "caller does not own this command",
    });
    expect(journal.cancel("cmd-1", "mallory")).toMatchObject({
      outcome: "rejected",
      detail: "caller does not own this command",
    });
  });

  it("stops dispatch when persisting dispatch intent fails", async () => {
    const journalPath = file();
    let writes = 0;
    const journal = openJournal(journalPath, {
      write: (target, body) => {
        writes += 1;
        if (writes === 2) throw new Error("disk full");
        writeFileSync(target, body);
      },
    });
    journal.admit(command());
    let applied = 0;
    expect(
      await journal.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({
      outcome: "unknown",
      detail: "dispatch was not durable",
      effectRan: false,
    });
    expect(applied).toBe(0);
    expect(journal.blocked).toBe(true);
    expect(
      journal.records().find((record) => record.commandId === "cmd-1")?.outcome,
    ).toBe("queued");

    const recovered = openJournal(journalPath);
    expect(
      recovered.records().find((record) => record.commandId === "cmd-1")
        ?.outcome,
    ).toBe("cancelled-before-dispatch");
    expect(
      await recovered.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({ outcome: "cancelled-before-dispatch" });
    expect(applied).toBe(0);
  });

  it("keeps uncertainty when persisting the final result fails", async () => {
    const journalPath = file();
    let writes = 0;
    const journal = openJournal(journalPath, {
      write: (target, body) => {
        writes += 1;
        if (writes === 3) throw new Error("disk full");
        writeFileSync(target, body);
      },
    });
    journal.admit(command());
    let applied = 0;
    expect(
      await journal.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({
      outcome: "unknown",
      detail: "result was not durable",
      effectRan: true,
    });
    expect(applied).toBe(1);
    expect(journal.blocked).toBe(true);
    expect(
      journal.records().find((record) => record.commandId === "cmd-1")?.outcome,
    ).toBe("dispatched");

    const recovered = openJournal(journalPath);
    expect(
      recovered.records().find((record) => record.commandId === "cmd-1")
        ?.outcome,
    ).toBe("unknown");
    expect(
      await recovered.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({ outcome: "unknown", effectRan: false });
    expect(applied).toBe(1);
  });

  it("leaves state untouched when persisting cancellation fails", () => {
    const journalPath = file();
    let writes = 0;
    const journal = openJournal(journalPath, {
      write: (target, body) => {
        writes += 1;
        if (writes === 2) throw new Error("disk full");
        writeFileSync(target, body);
      },
    });
    journal.admit(command());
    expect(journal.cancel("cmd-1", "dev")).toMatchObject({
      outcome: "queued",
      detail: "journal write failed",
    });
    expect(journal.blocked).toBe(true);
    expect(
      journal.records().find((record) => record.commandId === "cmd-1")?.outcome,
    ).toBe("queued");
    const recovered = openJournal(journalPath);
    expect(
      recovered.records().find((record) => record.commandId === "cmd-1")
        ?.outcome,
    ).toBe("cancelled-before-dispatch");
  });

  it("blocks when recovery cannot persist, without losing the settled state", () => {
    const journalPath = file();
    openJournal(journalPath).admit(command());
    const journal = openJournal(journalPath, {
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(journal.blocked).toBe(true);
    expect(journal.blockedReason).toBe("disk full");
    expect(journal.records()).toEqual([
      {
        commandId: "cmd-1",
        deviceId: "host-led",
        operation: "set",
        outcome: "cancelled-before-dispatch",
      },
    ]);
    expect(journal.admit(command())).toMatchObject({
      outcome: "cancelled-before-dispatch",
      detail: "journal is unavailable",
    });
  });

  it("never mistakes a recovery-write failure for first use", () => {
    const journalPath = file();
    openJournal(journalPath).admit(command());
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    const journal = openJournal(journalPath, {
      write: () => {
        throw missing;
      },
    });
    expect(journal.blocked).toBe(true);
    expect(journal.records()).toHaveLength(1);
  });

  it("treats damaged storage as blocked and preserves the original bytes", () => {
    const valid = {
      commandId: "cmd-1",
      callerId: "dev",
      deviceId: "host-led",
      operation: "set",
      payload: { on: true },
      payloadCanonical: '{"on":true}',
      deadlineMs: 1000,
      admittedAtMs: 0,
      outcome: "confirmed",
    };
    const cases: Array<[string, string]> = [
      ["not json", "{not-json"],
      ["not a list", '{"commandId":"cmd-1"}'],
      ["missing fields", '[{"commandId":"cmd-1","outcome":"confirmed"}]'],
      ["bad outcome", `[${JSON.stringify({ ...valid, outcome: "maybe" })}]`],
      ["unknown field", `[${JSON.stringify({ ...valid, extra: 1 })}]`],
      [
        "canonical mismatch",
        `[${JSON.stringify({ ...valid, payloadCanonical: "bogus" })}]`,
      ],
      [
        "duplicate ids",
        `[${JSON.stringify(valid)},${JSON.stringify({ ...valid, outcome: "queued" })}]`,
      ],
      [
        "invalid entry mid-array",
        `[${JSON.stringify(valid)},{"commandId":"bad"},${JSON.stringify({ ...valid, commandId: "cmd-2" })}]`,
      ],
    ];
    for (const [name, body] of cases) {
      const journalPath = file();
      writeFileSync(journalPath, body);
      const journal = openJournal(journalPath);
      expect(journal.blocked, name).toBe(true);
      expect(journal.blockedReason, name).not.toBeUndefined();
      expect(journal.records(), name).toEqual([]);
      expect(readFileSync(journalPath, "utf8"), name).toBe(body);
      expect(journal.admit(command()).detail, name).toBe(
        "journal is unavailable; command history could not be checked",
      );
    }
  });

  it("settles abandoned queued work during recovery without dispatch", () => {
    const journalPath = file();
    const crashed = openJournal(journalPath, { crashAt: "after-admit" });
    expect(() => crashed.admit(command())).toThrow(/after-admit/);
    const recovered = openJournal(journalPath);
    expect(recovered.records()).toEqual([
      {
        commandId: "cmd-1",
        deviceId: "host-led",
        operation: "set",
        outcome: "cancelled-before-dispatch",
      },
    ]);
    expect(readFileSync(journalPath, "utf8")).toContain(
      "cancelled-before-dispatch",
    );
    expect(recovered.admit(command())).toMatchObject({
      outcome: "cancelled-before-dispatch",
    });
    const reread = openJournal(journalPath);
    expect(
      reread.records().find((record) => record.commandId === "cmd-1")?.outcome,
    ).toBe("cancelled-before-dispatch");
  });

  it("reloads a crash after dispatch as unknown and never retries the effect", async () => {
    const journalPath = file();
    let applied = 0;
    const crashed = openJournal(journalPath, { crashAt: "after-dispatch" });
    crashed.admit(command());
    await expect(
      crashed.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).rejects.toThrow(/after-dispatch/);
    expect(applied).toBe(0);
    const recovered = openJournal(journalPath);
    expect(recovered.records()).toEqual([
      {
        commandId: "cmd-1",
        deviceId: "host-led",
        operation: "set",
        outcome: "unknown",
      },
    ]);
    expect(
      await recovered.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({ outcome: "unknown", effectRan: false });
    expect(applied).toBe(0);
    const reread = openJournal(journalPath);
    expect(
      reread.records().find((record) => record.commandId === "cmd-1")?.outcome,
    ).toBe("unknown");
  });

  it("keeps effect-ran uncertainty when the final write crashes", async () => {
    const journalPath = file();
    let applied = 0;
    const crashed = openJournal(journalPath, { crashAt: "after-effect" });
    crashed.admit(command());
    await expect(
      crashed.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).rejects.toThrow(/after-effect/);
    expect(applied).toBe(1);
    const recovered = openJournal(journalPath);
    expect(
      recovered.records().find((record) => record.commandId === "cmd-1")
        ?.outcome,
    ).toBe("unknown");
    expect(
      await recovered.dispatch("cmd-1", "dev", () => {
        applied += 1;
        return { outcome: "confirmed" };
      }),
    ).toMatchObject({ outcome: "unknown", effectRan: false });
    expect(applied).toBe(1);
  });

  it("runs concurrent dispatch of one command exactly once", async () => {
    const journal = openJournal(file());
    journal.admit(command());
    let release!: (outcome: EffectOutcome) => void;
    const gate = new Promise<EffectOutcome>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const effect = (): Promise<EffectOutcome> => {
      runs += 1;
      return gate;
    };
    const first = journal.dispatch("cmd-1", "dev", effect);
    const second = journal.dispatch("cmd-1", "dev", effect);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs).toBe(1);
    release({ outcome: "confirmed" });
    const [winner, joiner] = await Promise.all([first, second]);
    expect(runs).toBe(1);
    expect(winner).toMatchObject({ outcome: "confirmed", effectRan: true });
    expect(joiner).toMatchObject({ outcome: "confirmed", effectRan: false });
  });

  it("requires an existing data directory", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "november-journal-"));
    owned.push(directory);
    const journalPath = path.join(directory, "missing-dir", "journal.json");
    const journal = openJournal(journalPath);
    expect(journal.blocked).toBe(false);
    expect(journal.admit(command())).toMatchObject({
      outcome: "rejected",
      detail: "journal write failed",
    });
    expect(journal.blocked).toBe(true);
    expect(journal.blockedReason).toBe("journal directory does not exist");
  });

  it("validates commands, callers, and the clock", async () => {
    const journal = openJournal(file());
    expect(journal.admit(command({ commandId: "" })).detail).toBe(
      "command identity is invalid",
    );
    expect(journal.admit(command({ deadlineMs: Number.NaN })).detail).toBe(
      "command deadline is invalid",
    );
    expect(journal.admit(command({ deadlineMs: -1 })).detail).toBe(
      "command deadline is invalid",
    );
    expect(journal.admit(command({ policyVersion: Number.NaN })).detail).toBe(
      "policy version is invalid",
    );
    expect(journal.cancel("cmd-1", "")).toMatchObject({
      outcome: "rejected",
      detail: "caller id is required",
    });
    expect(
      await journal.dispatch("cmd-1", "", () => ({ outcome: "confirmed" })),
    ).toMatchObject({ outcome: "rejected", detail: "caller id is required" });

    const broken = openJournal(file(), { clock: () => Number.NaN });
    expect(broken.admit(command()).detail).toBe("clock reading is invalid");
    expect(
      await broken.dispatch("cmd-1", "dev", () => ({ outcome: "confirmed" })),
    ).toMatchObject({
      outcome: "rejected",
      detail: "clock reading is invalid",
    });
  });

  it("offers no deletion API until replay expiry is defined", () => {
    expect("reclaim" in openJournal(file())).toBe(false);
  });
});
