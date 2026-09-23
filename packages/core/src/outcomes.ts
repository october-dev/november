/**
 * Action outcome names from the v1 release contract (docs/release-gates.md,
 * "Outcome semantics"). Issue #10 owns the transitions, persistence, and
 * reconciliation rules; this module only fixes the shared vocabulary so every
 * package reports outcomes the same way.
 */
export const ACTION_OUTCOMES = [
  "rejected",
  "queued",
  "dispatched",
  "confirmed",
  "failed",
  "cancelled-before-dispatch",
  "unknown",
] as const;

export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

/** True when an outcome means the physical result is not established. */
export function isUncertain(outcome: ActionOutcome): boolean {
  return outcome === "unknown";
}
