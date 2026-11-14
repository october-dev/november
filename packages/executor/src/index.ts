/**
 * @november/executor — privileged device execution.
 *
 * Runs as its own process, separate from anything the model can reach.
 * Every physical dispatch passes through its policy checks (#8), action
 * journal (#10), and ownership/serialization rules (#11). Adapters are
 * loaded here, never in the agent process.
 *
 * The policy engine checks every request here. The dispatch path and
 * journal stay with their own issues.
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

export { createResourceGate } from "./gate.js";
export type {
  GateAccepted,
  GateKind,
  GateRejected,
  GateResult,
  PolicyDecision,
  ResourceGate,
} from "./gate.js";
export {
  checkEndpoint,
  createSecretStore,
  parseSecretRef,
  redactSecrets,
} from "./secrets.js";
export type {
  SecretPurpose,
  SecretRecord,
  SecretRef,
  SecretResult,
  SecretStore,
} from "./secrets.js";

export function executorStatus(): ExecutorStatus {
  return {
    ready: false,
    armed: false,
    protocolVersion: EXECUTOR_PROTOCOL_VERSION,
  };
}

export { parsePolicy } from "./policy.js";
export type {
  PolicyDevice,
  PolicyDocument,
  PolicyOperation,
  StateRequirement,
} from "./policy.js";
export { createExecutionService } from "./service.js";
export type {
  ApprovalResult,
  DeviceObservation,
  DeviceObserver,
  DeviceReader,
  EffectOutcome,
  ExecutionEffect,
  ExecutionRequest,
  ExecutionResult,
  ExecutionService,
  ServiceMode,
  ValidatedAction,
} from "./service.js";
