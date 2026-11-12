import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: [] as string[], nextFd: 100 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fdOf = (id: number): number => id;
  return {
    ...actual,
    openSync: vi.fn((target: string, flags: string, mode?: number) => {
      state.nextFd += 1;
      state.calls.push(`open:${target}:${flags}:${mode ?? ""}:${state.nextFd}`);
      return fdOf(state.nextFd);
    }),
    fchmodSync: vi.fn((fd: number, mode: number) => {
      state.calls.push(`fchmod:${fd}:${mode.toString(8)}`);
    }),
    writeSync: vi.fn((fd: number) => {
      state.calls.push(`write:${fd}`);
      return 1;
    }),
    fsyncSync: vi.fn((fd: number) => {
      state.calls.push(`fsync:${fd}`);
    }),
    closeSync: vi.fn((fd: number) => {
      state.calls.push(`close:${fd}`);
    }),
    renameSync: vi.fn((from: string, to: string) => {
      state.calls.push(`rename:${from}:${to}`);
    }),
  };
});

import { openJournal } from "./journal.js";

const owned: string[] = [];
afterEach(() => {
  while (owned.length > 0) {
    rmSync(owned.pop() as string, { recursive: true, force: true });
  }
  state.calls.length = 0;
});

describe("journal file ordering", () => {
  it("flushes the temp file, renames, then flushes the directory", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "november-journal-"));
    owned.push(directory);
    const journalPath = path.join(directory, "journal.json");
    const journal = openJournal(journalPath);
    journal.admit({
      commandId: "cmd-1",
      callerId: "dev",
      deviceId: "host-led",
      operation: "set",
      payload: { on: true },
      deadlineMs: 1000,
    });
    const temporary = `${journalPath}.tmp`;
    const kinds = state.calls.map((call) => call.split(":")[0]);
    expect(kinds).toEqual([
      "open",
      "fchmod",
      "write",
      "fsync",
      "close",
      "rename",
      "open",
      "fsync",
      "close",
    ]);
    const [tmpOpen, , , tmpSync, tmpClose, rename, dirOpen, dirSync, dirClose] =
      state.calls as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
    expect(tmpOpen).toBe(`open:${temporary}:w:384:101`);
    expect(tmpSync).toBe("fsync:101");
    expect(tmpClose).toBe("close:101");
    expect(rename).toBe(`rename:${temporary}:${journalPath}`);
    expect(dirOpen).toBe(`open:${directory}:r::102`);
    expect(dirSync).toBe("fsync:102");
    expect(dirClose).toBe("close:102");
    expect(journal.blocked).toBe(false);
  });
});
