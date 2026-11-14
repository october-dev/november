/**
 * Adapter lifecycle shared by simulated and real transports.
 *
 * discover lists resources and must not actuate, probe writable registers,
 * or send commands. open binds a configured identity and still must not
 * actuate. read returns an observation. execute submits one action.
 * reconcile reports the latest established outcome of a command id: it may
 * incorporate new evidence (unknown may become confirmed or failed), but it
 * must never redispatch the action. health describes the adapter, not a
 * physical output. close releases the handle. Closing a handle is not a
 * safe-state guarantee.
 *
 * Logical device ids bind at open: a single-resource adapter serves the
 * resource it opened, and reads or commands naming another device id must
 * fail rather than touch the open device. Selecting drivers for configured
 * devices, validating configured operations before hardware opens, and any
 * multi-device mapping remain #6 follow-up work, as do shared clock and
 * deadline ownership beyond the per-call timestamps used here.
 *
 * Unsupported operations return outcome `rejected` and do not change outputs.
 * An adapter reports only four outcomes: confirmed (the action actuated),
 * rejected (refused before actuation, without changing outputs), failed
 * (attempted with evidence of no effect, without changing outputs), or
 * unknown (the physical result cannot be shown; it may have actuated).
 * Unknown is not success and is not a reason to execute the command again.
 * reconcile of an id this adapter never accepted is `unknown`.
 *
 * Duplicate suppression inside the adapter is a best-effort session
 * cache: a repeated command id returns the latest established outcome
 * without actuating again. Durable deduplication, payload checks,
 * persistence, and retention belong to the action journal (#10), which
 * runs before adapter invocation.
 */
import type { DeviceAction } from "./action.js";
import type { ResourceIdentity } from "./identity.js";
import type { Observation } from "./observation.js";

export interface DiscoveredResource {
  readonly identity: ResourceIdentity;
  readonly label: string;
}

export interface AdapterHealth {
  readonly state: "closed" | "open" | "degraded";
  readonly detail: string;
}

/** Adapter-reported outcomes: the evidenced subset of the action vocabulary. */
export type AdapterOutcomeValue =
  "confirmed" | "rejected" | "failed" | "unknown";

export interface AdapterOutcome {
  readonly commandId: string;
  readonly outcome: AdapterOutcomeValue;
  readonly detail: string;
}

export type OpenResult =
  | { readonly ok: true; readonly identity: ResourceIdentity }
  | { readonly ok: false; readonly reason: string };

export interface DeviceAdapter {
  discover(): Promise<readonly DiscoveredResource[]>;
  open(configured: ResourceIdentity): Promise<OpenResult>;
  read(
    deviceId: string,
    operation: string,
    nowMs: number,
  ): Promise<Observation>;
  execute(action: DeviceAction, nowMs: number): Promise<AdapterOutcome>;
  reconcile(commandId: string): Promise<AdapterOutcome>;
  health(): AdapterHealth;
  close(): Promise<void>;
}
