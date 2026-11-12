/**
 * In-memory adapter for the reference devices. It implements the core
 * contract and never opens a device file. Issue #7 adds fault injection;
 * this module only provides the steady behavior those tests can wrap.
 */
import {
  bindResource,
  DEFAULT_FRESHNESS_MS,
  type AdapterHealth,
  type AdapterOutcome,
  type DeviceAction,
  type DeviceAdapter,
  type DiscoveredResource,
  type Observation,
  type OpenResult,
  type ResourceIdentity,
} from "@november/core";

interface SimDevice {
  readonly deviceId: string;
  readonly label: string;
  identity: ResourceIdentity;
  readonly readOperation: string;
  readonly actuateOperation?: string;
  level: boolean | number | null;
}

export interface SimulatedAdapter extends DeviceAdapter {
  readonly actuationCount: number;
  /** Test hook: the volatile path changed, the identity key did not. */
  replug(deviceId: string, path: string): void;
}

export function createSimulatedAdapter(): SimulatedAdapter {
  const devices = new Map<string, SimDevice>([
    [
      "host-led",
      {
        deviceId: "host-led",
        label: "Host diagnostic LED",
        identity: {
          kind: "gpio",
          key: "gpio:gpiochip0:17",
          path: "gpiochip0/17",
        },
        readOperation: "level",
        actuateOperation: "set",
        level: false,
      },
    ],
    [
      "host-button",
      {
        deviceId: "host-button",
        label: "Host button",
        identity: {
          kind: "gpio",
          key: "gpio:gpiochip0:27",
          path: "gpiochip0/27",
        },
        readOperation: "pressed",
        level: false,
      },
    ],
  ]);
  const outcomes = new Map<string, AdapterOutcome>();
  let openDevice: SimDevice | undefined;
  let actuations = 0;

  function closedOutcome(commandId: string): AdapterOutcome {
    return { commandId, outcome: "rejected", detail: "adapter is closed" };
  }

  const adapter: SimulatedAdapter = {
    get actuationCount() {
      return actuations;
    },
    replug(deviceId, path) {
      const device = devices.get(deviceId);
      if (!device) return;
      device.identity = { ...device.identity, path };
    },
    async discover() {
      return [...devices.values()].map((device): DiscoveredResource => ({
        identity: { ...device.identity },
        label: device.label,
      }));
    },
    async open(configured) {
      if (openDevice) return { ok: false, reason: "adapter is already open" };
      const matches = [...devices.values()].filter(
        (device) => bindResource(configured, device.identity).ok,
      );
      const device = matches[0];
      if (!device) {
        return {
          ok: false,
          reason:
            "identity key does not match; the resource at this path is a different device",
        };
      }
      const bound = bindResource(configured, device.identity);
      if (!bound.ok) return bound;
      device.identity = bound.identity;
      openDevice = device;
      return { ok: true };
    },
    async read(deviceId, operation, nowMs) {
      const device = openDevice?.deviceId === deviceId ? openDevice : undefined;
      if (!device || device.readOperation !== operation) {
        return observation(deviceId, operation, nowMs, null, "missing");
      }
      return observation(deviceId, operation, nowMs, device.level, "valid");
    },
    async execute(action, _nowMs) {
      if (!openDevice) return closedOutcome(action.commandId);
      const prior = outcomes.get(action.commandId);
      if (prior) return prior;
      if (
        openDevice.deviceId !== action.deviceId ||
        openDevice.actuateOperation !== action.operation
      ) {
        const outcome: AdapterOutcome = {
          commandId: action.commandId,
          outcome: "rejected",
          detail: "unsupported operation",
        };
        outcomes.set(action.commandId, outcome);
        return outcome;
      }
      if (typeof action.payload !== "boolean") {
        const outcome: AdapterOutcome = {
          commandId: action.commandId,
          outcome: "rejected",
          detail: "payload must be boolean",
        };
        outcomes.set(action.commandId, outcome);
        return outcome;
      }
      openDevice.level = action.payload;
      actuations += 1;
      const outcome: AdapterOutcome = {
        commandId: action.commandId,
        outcome: "confirmed",
        detail: action.payload ? "on" : "off",
      };
      outcomes.set(action.commandId, outcome);
      return outcome;
    },
    async reconcile(commandId) {
      return (
        outcomes.get(commandId) ?? {
          commandId,
          outcome: "unknown",
          detail: "no record of this command",
        }
      );
    },
    health(): AdapterHealth {
      return openDevice
        ? { state: "open", detail: openDevice.deviceId }
        : { state: "closed", detail: "not open" };
    },
    async close() {
      openDevice = undefined;
    },
  };
  return adapter;
}

function observation(
  deviceId: string,
  operation: string,
  nowMs: number,
  value: boolean | number | null,
  validity: Observation["validity"],
): Observation {
  return {
    source: { deviceId, operation },
    timestampMs: nowMs,
    freshnessMs: DEFAULT_FRESHNESS_MS,
    validity,
    value,
  };
}
