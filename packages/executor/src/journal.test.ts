import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openJournal, type JournalCommand } from "./journal.js";

function file(): string {
  return path.join(
    mkdtempSync(path.join(tmpdir(), "november-journal-")),
    "journal.json",
  );
}

const command: JournalCommand = {
  commandId: "cmd-1",
  callerId: "dev",
  deviceId: "host-led",
  operation: "set",
  payload: { on: true },
  policyVersion: 3,
  deadlineMs: 1000,
};

describe("action journal", () => {
  it("persists a command before dispatch and does not repeat it", () => {
    const journalPath = file();
    let applied = 0;
    const journal = openJournal(journalPath);
    const first = journal.submit(command, 100, () => {
      applied += 1;
    });
    expect(first).toMatchObject({ outcome: "confirmed", applied: true });
    expect(applied).toBe(1);
    const again = journal.submit(command, 200, () => {
      applied += 1;
    });
    expect(again).toMatchObject({ outcome: "confirmed", applied: false });
    expect(applied).toBe(1);
    const changed = journal.submit(
      { ...command, payload: { on: false } },
      300,
      () => {
        applied += 1;
      },
    );
    expect(changed.outcome).toBe("rejected");
    expect(applied).toBe(1);
    const saved = readFileSync(journalPath, "utf8");
    expect(saved).toContain("confirmed");
  });

  it("cancels only before dispatch and does not claim a dispatched action was undone", () => {
    const journalPath = file();
    const journal = openJournal(journalPath, { crashAt: "after-queue" });
    expect(() => journal.submit(command, 100, () => undefined)).toThrow(
      /after-queue/,
    );
    const reopened = openJournal(journalPath);
    expect(reopened.records()).toEqual([
      { commandId: "cmd-1", outcome: "queued" },
    ]);
    expect(reopened.cancel("cmd-1", 150)).toMatchObject({
      outcome: "cancelled-before-dispatch",
    });

    const dispatched = file();
    const running = openJournal(dispatched);
    running.submit(command, 100, () => undefined);
    expect(running.cancel("cmd-1", 200).detail).toMatch(/does not undo/);
    expect(running.records()[0]?.outcome).toBe("confirmed");
  });

  it("reloads a crash after dispatch as unknown and does not retry the effect", () => {
    const journalPath = file();
    let applied = 0;
    const crashed = openJournal(journalPath, { crashAt: "after-dispatch" });
    expect(() =>
      crashed.submit(command, 100, () => {
        applied += 1;
      }),
    ).toThrow(/after-dispatch/);
    expect(applied).toBe(0);
    const recovered = openJournal(journalPath);
    expect(recovered.records()).toEqual([
      { commandId: "cmd-1", outcome: "unknown" },
    ]);
    const retry = recovered.submit(command, 500, () => {
      applied += 1;
    });
    expect(retry).toMatchObject({ outcome: "unknown", applied: false });
    expect(applied).toBe(0);
  });

  it("keeps an effect that ran when the confirmation write did not", () => {
    const journalPath = file();
    let applied = 0;
    const crashed = openJournal(journalPath, { crashAt: "after-effect" });
    expect(() =>
      crashed.submit(command, 100, () => {
        applied += 1;
      }),
    ).toThrow(/after-effect/);
    expect(applied).toBe(1);
    const recovered = openJournal(journalPath);
    expect(recovered.records()[0]?.outcome).toBe("unknown");
    recovered.submit(command, 200, () => {
      applied += 1;
    });
    expect(applied).toBe(1);
  });

  it("blocks new actions when the journal cannot be saved or is corrupt", () => {
    const journalPath = file();
    const failing = openJournal(journalPath, {
      write: () => {
        throw new Error("disk full");
      },
    });
    let applied = 0;
    const blocked = failing.submit(command, 100, () => {
      applied += 1;
    });
    expect(blocked).toMatchObject({
      outcome: "rejected",
      detail: "journal write failed",
    });
    expect(applied).toBe(0);
    expect(failing.blocked).toBe(true);

    writeFileSync(journalPath, "{not-json");
    const corrupt = openJournal(journalPath);
    expect(corrupt.blocked).toBe(true);
    expect(corrupt.submit(command, 100, () => undefined).detail).toMatch(
      /unavailable/,
    );
  });

  it("reclaims old terminal records and keeps unknown ones", () => {
    const journalPath = file();
    const journal = openJournal(journalPath);
    journal.submit(command, 1_000, () => undefined);
    journal.submit({ ...command, commandId: "cmd-2" }, 1_000, () => {
      throw new Error("lost");
    });
    expect(
      journal.records().find((record) => record.commandId === "cmd-2")?.outcome,
    ).toBe("unknown");
    expect(journal.reclaim(20_000, 5_000)).toBe(1);
    expect(journal.records().map((record) => record.commandId)).toEqual([
      "cmd-2",
    ]);
  });
});
