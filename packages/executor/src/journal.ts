/**
 * Durable action journal (issue #10).
 *
 * Admission and dispatch are separate steps. admit() persists a queued
 * record; dispatch() checks the elapsed deadline, persists the dispatch
 * intent, runs the effect once, and persists the effect's explicit
 * outcome. A record is on disk before dispatch, and a crash after that
 * point reloads as `unknown` without running the effect again. The
 * journal does not claim that a local write and a physical device commit
 * together.
 *
 * Every persist writes a temporary file, flushes it, renames it over the
 * journal, and flushes the containing directory. Files are private
 * (0600). The data directory must already exist; the journal never
 * creates it, so an unmounted location cannot look like first use.
 * Power-loss durability still needs filesystem/device qualification.
 *
 * Time comes from one caller-supplied millisecond clock for admission
 * and dispatch. Deadline comparisons are elapsed durations, so queued
 * records abandoned by a crash settle to cancelled-before-dispatch on
 * recovery and can never dispatch late, whatever the clock does across
 * a restart.
 *
 * One live journal owns each path: two instances would double-execute
 * and overwrite each other's records. The service must enforce that.
 * Command identity is caller, device, operation, payload, and deadline;
 * a policy version stamped on the record is compared only when the
 * request itself carries one. Payloads are validated finite JSON and
 * are snapshotted at admission. Reconciliation updates, retention
 * expiry, and journal size caps remain #10 follow-up work; there is
 * deliberately no deletion API until replay expiry is defined.
 */
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { ACTION_OUTCOMES, type ActionOutcome } from "@november/core";

export interface JournalCommand {
  readonly commandId: string;
  readonly callerId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly payload: unknown;
  /** Compared only when the request itself carries a version. */
  readonly policyVersion?: number;
  /** Duration in milliseconds from admission. */
  readonly deadlineMs: number;
}

interface StoredCommand {
  readonly commandId: string;
  readonly callerId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly payload: unknown;
  readonly payloadCanonical: string;
  readonly policyVersion: number | undefined;
  readonly deadlineMs: number;
  readonly admittedAtMs: number;
  readonly outcome: ActionOutcome;
}

export interface JournalResult {
  readonly outcome: ActionOutcome;
  readonly detail: string;
  /** True when this call invoked the effect (which may have failed). */
  readonly effectRan: boolean;
}

export interface EffectOutcome {
  readonly outcome: "confirmed" | "failed" | "unknown";
  readonly detail?: string;
}

export type JournalEffect = () => EffectOutcome | Promise<EffectOutcome>;

export interface JournalRecordView {
  readonly commandId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly outcome: ActionOutcome;
}

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalError";
  }
}

export type CrashPoint = "after-admit" | "after-dispatch" | "after-effect";

export interface ActionJournal {
  readonly blocked: boolean;
  readonly blockedReason: string | undefined;
  admit(command: JournalCommand): JournalResult;
  dispatch(
    commandId: string,
    callerId: string,
    effect: JournalEffect,
  ): Promise<JournalResult>;
  cancel(commandId: string, callerId: string): JournalResult;
  records(): readonly JournalRecordView[];
}

const UNAVAILABLE = "journal is unavailable";
const HISTORY_UNCHECKED =
  "journal is unavailable; command history could not be checked";

export function openJournal(
  filePath: string,
  options: {
    readonly crashAt?: CrashPoint;
    readonly write?: (path: string, body: string) => void;
    readonly clock?: () => number;
  } = {},
): ActionJournal {
  const clock = options.clock ?? Date.now;
  let blocked = false;
  let blockedReason: string | undefined;
  const records = new Map<string, StoredCommand>();
  const inFlight = new Map<string, Promise<JournalResult>>();

  const latch = (reason: string): void => {
    blocked = true;
    if (blockedReason === undefined) blockedReason = reason;
  };

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const loaded = parseStoredList(parsed);
    let settled = false;
    for (const stored of loaded) {
      let outcome = stored.outcome;
      if (outcome === "queued") {
        outcome = "cancelled-before-dispatch";
        settled = true;
      } else if (outcome === "dispatched") {
        outcome = "unknown";
        settled = true;
      }
      records.set(stored.commandId, { ...stored, outcome });
    }
    if (settled) {
      try {
        persist(filePath, records, options.write);
      } catch (error) {
        latch(reasonOf(error));
      }
    }
  } catch (error) {
    if (isNotFound(error)) {
      // Absent initial file only: first use. Every other failure,
      // including a failed recovery write above (handled separately),
      // blocks the journal with its cause preserved.
    } else if (error instanceof JournalError) {
      latch(error.message);
    } else {
      latch(reasonOf(error));
    }
    if (blocked) records.clear();
  }

  function readClock(): number | undefined {
    const now = clock();
    return Number.isFinite(now) ? now : undefined;
  }

  // Persist a staged copy, then install it. A failed save leaves the
  // in-memory state untouched, so it never masquerades as committed.
  function commit(
    mutate: (draft: Map<string, StoredCommand>) => void,
    point?: CrashPoint,
  ): void {
    const draft = new Map(records);
    mutate(draft);
    persist(filePath, draft, options.write);
    if (point && options.crashAt === point) {
      throw new JournalError(`crashed ${point}`);
    }
    records.clear();
    for (const [id, stored] of draft) records.set(id, stored);
  }

  function knownResult(stored: StoredCommand): JournalResult {
    const outcome =
      stored.outcome === "dispatched" ? "unknown" : stored.outcome;
    return {
      outcome,
      detail:
        stored.outcome === "dispatched"
          ? "dispatch did not complete"
          : "existing record",
      effectRan: false,
    };
  }

  function unavailableKnown(stored: StoredCommand): JournalResult {
    return {
      outcome: normalize(stored.outcome),
      detail: UNAVAILABLE,
      effectRan: false,
    };
  }

  function unavailableUnknown(): JournalResult {
    return { outcome: "rejected", detail: HISTORY_UNCHECKED, effectRan: false };
  }

  async function runDispatch(
    stored: StoredCommand,
    effect: JournalEffect,
  ): Promise<JournalResult> {
    const started = readClock();
    if (started === undefined) {
      return {
        outcome: "rejected",
        detail: "clock reading is invalid",
        effectRan: false,
      };
    }
    if (started - stored.admittedAtMs > stored.deadlineMs) {
      try {
        commit((draft) => {
          draft.set(stored.commandId, {
            ...stored,
            outcome: "cancelled-before-dispatch",
          });
        });
      } catch (error) {
        if (isCrash(error)) throw error;
        latch(reasonOf(error));
        return {
          outcome: "queued",
          detail: "journal write failed",
          effectRan: false,
        };
      }
      return {
        outcome: "cancelled-before-dispatch",
        detail: "deadline expired before dispatch",
        effectRan: false,
      };
    }
    try {
      commit((draft) => {
        draft.set(stored.commandId, { ...stored, outcome: "dispatched" });
      }, "after-dispatch");
    } catch (error) {
      if (isCrash(error)) throw error;
      latch(reasonOf(error));
      return {
        outcome: "unknown",
        detail: "dispatch was not durable",
        effectRan: false,
      };
    }
    const beforeEffect = readClock();
    if (beforeEffect === undefined) {
      return {
        outcome: "rejected",
        detail: "clock reading is invalid",
        effectRan: false,
      };
    }
    if (beforeEffect - stored.admittedAtMs > stored.deadlineMs) {
      try {
        commit((draft) => {
          draft.set(stored.commandId, {
            ...stored,
            outcome: "cancelled-before-dispatch",
          });
        });
      } catch (error) {
        if (isCrash(error)) throw error;
        latch(reasonOf(error));
        return {
          outcome: "queued",
          detail: "journal write failed",
          effectRan: false,
        };
      }
      return {
        outcome: "cancelled-before-dispatch",
        detail: "deadline expired before dispatch",
        effectRan: false,
      };
    }
    let reported: EffectOutcome;
    try {
      reported = await effect();
    } catch {
      return finishDispatch(stored, {
        outcome: "unknown",
        detail: "effect failed after dispatch",
      });
    }
    if (!isEffectOutcome(reported)) {
      return finishDispatch(stored, {
        outcome: "unknown",
        detail: "effect reported an invalid outcome",
      });
    }
    return finishDispatch(stored, reported);
  }

  function finishDispatch(
    stored: StoredCommand,
    reported: EffectOutcome,
  ): JournalResult {
    if (options.crashAt === "after-effect") {
      throw new JournalError("crashed after-effect");
    }
    try {
      commit((draft) => {
        draft.set(stored.commandId, { ...stored, outcome: reported.outcome });
      });
    } catch (error) {
      if (isCrash(error)) throw error;
      latch(reasonOf(error));
      return {
        outcome: "unknown",
        detail: "result was not durable",
        effectRan: true,
      };
    }
    return {
      outcome: reported.outcome,
      detail:
        reported.detail ??
        (reported.outcome === "confirmed"
          ? "applied"
          : reported.outcome === "failed"
            ? "effect reported failure"
            : "effect did not confirm"),
      effectRan: true,
    };
  }

  return {
    get blocked() {
      return blocked;
    },
    get blockedReason() {
      return blockedReason;
    },
    admit(command) {
      const now = readClock();
      if (now === undefined) {
        return {
          outcome: "rejected",
          detail: "clock reading is invalid",
          effectRan: false,
        };
      }
      const invalid = checkCommand(command);
      if (invalid) {
        return { outcome: "rejected", detail: invalid, effectRan: false };
      }
      const existing = records.get(command.commandId);
      if (blocked) {
        return existing ? unavailableKnown(existing) : unavailableUnknown();
      }
      const canonical = canonicalize(command.payload);
      if (existing) {
        if (!sameIdentity(existing, command, canonical)) {
          return {
            outcome: "rejected",
            detail: "command id was already used with different parameters",
            effectRan: false,
          };
        }
        return knownResult(existing);
      }
      const stored: StoredCommand = {
        commandId: command.commandId,
        callerId: command.callerId,
        deviceId: command.deviceId,
        operation: command.operation,
        payload: snapshot(command.payload),
        payloadCanonical: canonical,
        policyVersion: command.policyVersion,
        deadlineMs: command.deadlineMs,
        admittedAtMs: now,
        outcome: "queued",
      };
      try {
        commit((draft) => {
          draft.set(stored.commandId, stored);
        }, "after-admit");
      } catch (error) {
        if (isCrash(error)) throw error;
        latch(reasonOf(error));
        return {
          outcome: "rejected",
          detail: "journal write failed",
          effectRan: false,
        };
      }
      return { outcome: "queued", detail: "admitted", effectRan: false };
    },
    async dispatch(commandId, callerId, effect) {
      if (readClock() === undefined) {
        return {
          outcome: "rejected",
          detail: "clock reading is invalid",
          effectRan: false,
        };
      }
      if (typeof callerId !== "string" || callerId.length === 0) {
        return {
          outcome: "rejected",
          detail: "caller id is required",
          effectRan: false,
        };
      }
      const stored = records.get(commandId);
      if (blocked) {
        return stored ? unavailableKnown(stored) : unavailableUnknown();
      }
      if (!stored) {
        return {
          outcome: "rejected",
          detail: "unknown command",
          effectRan: false,
        };
      }
      if (stored.callerId !== callerId) {
        return {
          outcome: "rejected",
          detail: "caller does not own this command",
          effectRan: false,
        };
      }
      const ongoing = inFlight.get(commandId);
      if (ongoing) {
        const result = await ongoing;
        return { ...result, effectRan: false };
      }
      if (stored.outcome !== "queued") {
        return knownResult(stored);
      }
      let settle!: (result: JournalResult) => void;
      const gate = new Promise<JournalResult>((resolve) => {
        settle = resolve;
      });
      inFlight.set(commandId, gate);
      try {
        const result = await runDispatch(
          records.get(commandId) ?? stored,
          effect,
        );
        settle(result);
        return result;
      } catch (error) {
        // A crash hook simulates process death; joiners must not hang.
        settle({
          outcome: "unknown",
          detail: "dispatch was interrupted",
          effectRan: false,
        });
        throw error;
      } finally {
        inFlight.delete(commandId);
      }
    },
    cancel(commandId, callerId) {
      if (typeof callerId !== "string" || callerId.length === 0) {
        return {
          outcome: "rejected",
          detail: "caller id is required",
          effectRan: false,
        };
      }
      const stored = records.get(commandId);
      if (blocked) {
        return stored ? unavailableKnown(stored) : unavailableUnknown();
      }
      if (!stored) {
        return {
          outcome: "rejected",
          detail: "unknown command",
          effectRan: false,
        };
      }
      if (stored.callerId !== callerId) {
        return {
          outcome: "rejected",
          detail: "caller does not own this command",
          effectRan: false,
        };
      }
      if (stored.outcome !== "queued") {
        if (stored.outcome === "cancelled-before-dispatch") {
          return {
            outcome: stored.outcome,
            detail: "already cancelled",
            effectRan: false,
          };
        }
        return {
          outcome: normalize(stored.outcome),
          detail: "cancellation does not undo a dispatched action",
          effectRan: false,
        };
      }
      try {
        commit((draft) => {
          draft.set(commandId, {
            ...stored,
            outcome: "cancelled-before-dispatch",
          });
        });
      } catch (error) {
        if (isCrash(error)) throw error;
        latch(reasonOf(error));
        return {
          outcome: "queued",
          detail: "journal write failed",
          effectRan: false,
        };
      }
      return {
        outcome: "cancelled-before-dispatch",
        detail: "cancelled before dispatch",
        effectRan: false,
      };
    },
    records() {
      return [...records.values()].map((record) => ({
        commandId: record.commandId,
        deviceId: record.deviceId,
        operation: record.operation,
        outcome: record.outcome,
      }));
    },
  };
}

function normalize(outcome: ActionOutcome): ActionOutcome {
  return outcome === "dispatched" ? "unknown" : outcome;
}

function persist(
  filePath: string,
  records: ReadonlyMap<string, StoredCommand>,
  write: ((path: string, body: string) => void) | undefined,
): void {
  const body = `${JSON.stringify(
    [...records.values()].map((record) => ({
      commandId: record.commandId,
      callerId: record.callerId,
      deviceId: record.deviceId,
      operation: record.operation,
      payload: record.payload,
      payloadCanonical: record.payloadCanonical,
      policyVersion: record.policyVersion,
      deadlineMs: record.deadlineMs,
      admittedAtMs: record.admittedAtMs,
      outcome: record.outcome,
    })),
  )}\n`;
  if (write) {
    write(filePath, body);
    return;
  }
  const directory = path.dirname(filePath);
  let dirStat;
  try {
    dirStat = statSync(directory);
  } catch (error) {
    if (isNotFound(error)) {
      throw new JournalError("journal directory does not exist");
    }
    throw error;
  }
  if (!dirStat.isDirectory()) {
    throw new JournalError("journal directory does not exist");
  }
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

const STORED_KEYS = new Set([
  "commandId",
  "callerId",
  "deviceId",
  "operation",
  "payload",
  "payloadCanonical",
  "policyVersion",
  "deadlineMs",
  "admittedAtMs",
  "outcome",
]);

function parseStoredList(value: unknown): StoredCommand[] {
  if (!Array.isArray(value)) throw new JournalError("journal is not a list");
  const seen = new Set<string>();
  return value.map((entry) => {
    const stored = parseStored(entry);
    if (seen.has(stored.commandId)) {
      throw new JournalError("journal has a duplicate command id");
    }
    seen.add(stored.commandId);
    return stored;
  });
}

function parseStored(value: unknown): StoredCommand {
  if (!value || typeof value !== "object") {
    throw new JournalError("journal record is malformed");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!STORED_KEYS.has(key)) {
      throw new JournalError("journal record has an unknown field");
    }
  }
  const {
    commandId,
    callerId,
    deviceId,
    operation,
    payload,
    payloadCanonical,
    policyVersion,
    deadlineMs,
    admittedAtMs,
    outcome,
  } = record;
  if (
    typeof commandId !== "string" ||
    commandId.length === 0 ||
    typeof callerId !== "string" ||
    callerId.length === 0 ||
    typeof deviceId !== "string" ||
    deviceId.length === 0 ||
    typeof operation !== "string" ||
    operation.length === 0 ||
    !isStorable(payload) ||
    typeof payloadCanonical !== "string" ||
    payloadCanonical !== canonicalize(payload) ||
    (policyVersion !== undefined &&
      (typeof policyVersion !== "number" || !Number.isFinite(policyVersion))) ||
    typeof deadlineMs !== "number" ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs < 0 ||
    typeof admittedAtMs !== "number" ||
    !Number.isFinite(admittedAtMs) ||
    typeof outcome !== "string" ||
    !(ACTION_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    throw new JournalError("journal record is malformed");
  }
  return {
    commandId,
    callerId,
    deviceId,
    operation,
    payload: snapshot(payload),
    payloadCanonical,
    policyVersion,
    deadlineMs,
    admittedAtMs,
    outcome: outcome as ActionOutcome,
  };
}

function checkCommand(command: JournalCommand): string | undefined {
  if (
    typeof command.commandId !== "string" ||
    command.commandId.length === 0 ||
    typeof command.callerId !== "string" ||
    command.callerId.length === 0 ||
    typeof command.deviceId !== "string" ||
    command.deviceId.length === 0 ||
    typeof command.operation !== "string" ||
    command.operation.length === 0
  ) {
    return "command identity is invalid";
  }
  if (!isStorable(command.payload)) return "command payload is not supported";
  if (
    command.policyVersion !== undefined &&
    (typeof command.policyVersion !== "number" ||
      !Number.isFinite(command.policyVersion))
  ) {
    return "policy version is invalid";
  }
  if (
    typeof command.deadlineMs !== "number" ||
    !Number.isFinite(command.deadlineMs) ||
    command.deadlineMs < 0
  ) {
    return "command deadline is invalid";
  }
  return undefined;
}

function sameIdentity(
  stored: StoredCommand,
  command: JournalCommand,
  canonical: string,
): boolean {
  if (
    stored.callerId !== command.callerId ||
    stored.deviceId !== command.deviceId ||
    stored.operation !== command.operation ||
    stored.payloadCanonical !== canonical ||
    stored.deadlineMs !== command.deadlineMs
  ) {
    return false;
  }
  if (
    stored.policyVersion !== undefined &&
    command.policyVersion !== undefined &&
    stored.policyVersion !== command.policyVersion
  ) {
    return false;
  }
  return true;
}

function isEffectOutcome(value: unknown): value is EffectOutcome {
  if (!value || typeof value !== "object") return false;
  const outcome = (value as Partial<EffectOutcome>).outcome;
  const detail = (value as Partial<EffectOutcome>).detail;
  return (
    (outcome === "confirmed" ||
      outcome === "failed" ||
      outcome === "unknown") &&
    (detail === undefined || typeof detail === "string")
  );
}

/** Finite JSON only: no undefined, NaN, class instances, or exotic objects. */
function isStorable(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isStorable);
  if (typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isStorable);
}

function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshot);
  if (value !== null && typeof value === "object") {
    // A null prototype keeps an own "__proto__" key as data, matching
    // the canonical form so reload verification agrees.
    const copy: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = snapshot(entry);
    }
    return copy;
  }
  return value;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  // A null prototype keeps an own "__proto__" key as data, not a setter.
  const sorted: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function reasonOf(error: unknown): string {
  if (error instanceof JournalError) return error.message;
  if (error instanceof Error) return error.message;
  return "journal storage failed";
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

function isCrash(error: unknown): boolean {
  return error instanceof JournalError && error.message.startsWith("crashed ");
}
