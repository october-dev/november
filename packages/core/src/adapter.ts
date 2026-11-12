/**
 * Adapter lifecycle shared by simulated and real transports.
 *
 * discover lists resources and must not actuate, probe writable registers,
 * or send commands. open binds a configured identity and still must not
 * actuate. read returns an observation. execute submits one action.
 * reconcile reports the stored outcome of a command id and must not repeat
 * the action. health describes the adapter, not a physical output. close
 * releases the handle. Closing a handle is not a safe-state guarantee.
 *
 * Unsupported operations return outcome `rejected` and do not change outputs.
 * An action whose physical result cannot be shown returns `unknown`. Unknown
 * is not success and is not a reason to execute the command again. reconcile
 * of an id this adapter never accepted is `unknown`.
 */
import type { ActionOutcome } from "./outcomes.js";
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

export interface AdapterOutcome {
  readonly commandId: string;
  readonly outcome: ActionOutcome;
  readonly detail: string;
}

export type OpenResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

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
