/**
 * @november/executor — privileged device execution.
 *
 * Runs as its own process, separate from anything the model can reach.
 * Every physical dispatch passes through its policy checks (#8), action
 * journal (#10), and ownership/serialization rules (#11). Adapters are
 * loaded here, never in the agent process.
 *
 * The action journal records outcomes before and after dispatch.
 * Policy checks and ownership rules stay with their own issues.
 */
import type { ActionOutcome } from "@november/core";

/** Bumped whenever the executor's request/reply contract changes. */
export const EXECUTOR_PROTOCOL_VERSION = 0;

export interface ExecutorStatus {
  /** Policy validated, dependencies checked, reconciliation finished. */
  readonly ready: boolean;
  /** Outputs may only energize while armed; restart never auto-arms. */
  readonly armed: boolean;
  readonly protocolVersion: number;
}

/** Outcome a not-yet-implemented executor must report: never a fake success. */
export const UNIMPLEMENTED_OUTCOME: ActionOutcome = "rejected";

export { JournalError, openJournal } from "./journal.js";
export type {
  ActionJournal,
  CrashPoint,
  EffectOutcome,
  JournalCommand,
  JournalEffect,
  JournalRecordView,
  JournalResult,
} from "./journal.js";

export function executorStatus(): ExecutorStatus {
  return {
    ready: false,
    armed: false,
    protocolVersion: EXECUTOR_PROTOCOL_VERSION,
  };
}
