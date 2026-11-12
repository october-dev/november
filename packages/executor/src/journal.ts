/**
 * Durable action journal (issue #10).
 *
 * A record is on disk before dispatch. A crash after that point reloads as
 * `unknown` and does not run the effect again. The journal does not claim
 * that a local write and a physical device commit together.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ACTION_OUTCOMES, type ActionOutcome } from "@november/core";

export interface JournalCommand {
  readonly commandId: string;
  readonly callerId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly payload: unknown;
  readonly policyVersion: number;
  readonly deadlineMs: number;
}

interface StoredCommand extends JournalCommand {
  readonly payloadCanonical: string;
  outcome: ActionOutcome;
  readonly admittedAtMs: number;
}

export interface JournalResult {
  readonly outcome: ActionOutcome;
  readonly detail: string;
  readonly applied: boolean;
}

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalError";
  }
}

export type CrashPoint = "after-queue" | "after-dispatch" | "after-effect";

export interface ActionJournal {
  readonly blocked: boolean;
  submit(
    command: JournalCommand,
    nowMs: number,
    effect: () => void,
  ): JournalResult;
  cancel(commandId: string, nowMs: number): JournalResult;
  /** Drop only terminal records older than `ttlMs`. Unknown work stays. */
  reclaim(nowMs: number, ttlMs: number): number;
  records(): readonly {
    readonly commandId: string;
    readonly outcome: ActionOutcome;
  }[];
}

export function openJournal(
  filePath: string,
  options: {
    readonly crashAt?: CrashPoint;
    readonly write?: (path: string, body: string) => void;
  } = {},
): ActionJournal {
  const records = new Map<string, StoredCommand>();
  let blocked = false;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new JournalError("journal is not a list");
    for (const entry of parsed) {
      const stored = parseStored(entry);
      if (stored.outcome === "dispatched") stored.outcome = "unknown";
      records.set(stored.commandId, stored);
    }
    if ([...records.values()].some((record) => record.outcome === "unknown")) {
      persist(filePath, records, options.write);
    }
  } catch (error) {
    if (!isNotFound(error)) blocked = true;
  }

  function save(point?: CrashPoint): void {
    persist(filePath, records, options.write);
    if (point && options.crashAt === point)
      throw new JournalError(`crashed ${point}`);
  }

  return {
    get blocked() {
      return blocked;
    },
    submit(command, nowMs, effect) {
      if (blocked) {
        return {
          outcome: "rejected",
          detail: "journal is unavailable",
          applied: false,
        };
      }
      const canonical = canonicalize(command.payload);
      const existing = records.get(command.commandId);
      if (existing) {
        if (
          existing.payloadCanonical !== canonical ||
          existing.deviceId !== command.deviceId
        ) {
          return {
            outcome: "rejected",
            detail: "command id was already used with different parameters",
            applied: false,
          };
        }
        return {
          outcome: existing.outcome,
          detail: "existing record",
          applied: false,
        };
      }
      const stored: StoredCommand = {
        ...command,
        payloadCanonical: canonical,
        outcome: "queued",
        admittedAtMs: nowMs,
      };
      records.set(command.commandId, stored);
      try {
        save("after-queue");
      } catch (error) {
        records.delete(command.commandId);
        if (isCrash(error)) throw error;
        blocked = true;
        return {
          outcome: "rejected",
          detail: "journal write failed",
          applied: false,
        };
      }
      if (nowMs - stored.admittedAtMs > command.deadlineMs) {
        stored.outcome = "cancelled-before-dispatch";
        save();
        return {
          outcome: stored.outcome,
          detail: "deadline expired before dispatch",
          applied: false,
        };
      }
      stored.outcome = "dispatched";
      try {
        save("after-dispatch");
      } catch (error) {
        if (isCrash(error)) throw error;
        blocked = true;
        stored.outcome = "unknown";
        return {
          outcome: "unknown",
          detail: "dispatch was not durable",
          applied: false,
        };
      }
      try {
        effect();
      } catch {
        stored.outcome = "unknown";
        try {
          save();
        } catch {
          blocked = true;
        }
        return {
          outcome: "unknown",
          detail: "effect failed after dispatch",
          applied: true,
        };
      }
      try {
        save("after-effect");
      } catch (error) {
        if (isCrash(error)) throw error;
        blocked = true;
        stored.outcome = "unknown";
        return {
          outcome: "unknown",
          detail: "result was not durable",
          applied: true,
        };
      }
      stored.outcome = "confirmed";
      try {
        save();
      } catch {
        blocked = true;
        stored.outcome = "unknown";
        return {
          outcome: "unknown",
          detail: "confirmation was not durable",
          applied: true,
        };
      }
      return { outcome: "confirmed", detail: "applied", applied: true };
    },
    cancel(commandId, _nowMs) {
      const stored = records.get(commandId);
      if (!stored)
        return {
          outcome: "rejected",
          detail: "unknown command",
          applied: false,
        };
      if (stored.outcome === "queued") {
        stored.outcome = "cancelled-before-dispatch";
        save();
        return {
          outcome: stored.outcome,
          detail: "cancelled before dispatch",
          applied: false,
        };
      }
      return {
        outcome: stored.outcome,
        detail: "cancellation does not undo a dispatched action",
        applied: false,
      };
    },
    reclaim(nowMs, ttlMs) {
      let removed = 0;
      for (const [id, record] of records) {
        const terminal =
          record.outcome === "confirmed" ||
          record.outcome === "failed" ||
          record.outcome === "rejected" ||
          record.outcome === "cancelled-before-dispatch";
        if (terminal && nowMs - record.admittedAtMs > ttlMs) {
          records.delete(id);
          removed += 1;
        }
      }
      if (removed > 0) save();
      return removed;
    },
    records() {
      return [...records.values()].map((record) => ({
        commandId: record.commandId,
        outcome: record.outcome,
      }));
    },
  };
}

function persist(
  filePath: string,
  records: ReadonlyMap<string, StoredCommand>,
  write: ((path: string, body: string) => void) | undefined,
): void {
  const body = `${JSON.stringify([...records.values()])}\n`;
  if (write) {
    write(filePath, body);
    return;
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, body);
  renameSync(temporary, filePath);
}

function parseStored(value: unknown): StoredCommand {
  if (!value || typeof value !== "object")
    throw new JournalError("journal record is malformed");
  const record = value as Partial<StoredCommand>;
  if (
    typeof record.commandId !== "string" ||
    typeof record.outcome !== "string" ||
    !(ACTION_OUTCOMES as readonly string[]).includes(record.outcome)
  ) {
    throw new JournalError("journal record is malformed");
  }
  return record as StoredCommand;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isCrash(error: unknown): boolean {
  return error instanceof JournalError && error.message.startsWith("crashed ");
}
