import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessObservation,
  bindResource,
  checkAdapterContract,
  parseDeviceAction,
  parseObservation,
  parseResourceIdentity,
  type DeviceAction,
  type DeviceAdapter,
  type ResourceIdentity,
} from "./index.js";

function load(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

describe("observations and actions", () => {
  it("accepts the checked-in examples and rejects unknown fields", () => {
    const observation = parseObservation(load("observation.json"));
    expect(observation.ok).toBe(true);
    const action = parseDeviceAction(load("action.json"));
    expect(action.ok).toBe(true);
    if (!observation.ok || !action.ok) return;
    expect(observation.value.unit).toBe("degC");
    expect(action.value.expectedState).toBe(false);

    const extra = load("observation.json") as Record<string, unknown>;
    extra.note = "do not keep";
    const errors = parseObservation(extra);
    expect(errors.ok).toBe(false);
    if (!errors.ok) {
      expect(errors.errors).toEqual([
        { path: "note", message: "is not a known field" },
      ]);
    }
  });

  it("marks a reading stale at the freshness limit without touching a device", () => {
    const reading = assessObservation(
      {
        source: { deviceId: "bme280", operation: "temperature" },
        timestampMs: 1_000,
        freshnessMs: 10_000,
        value: 21.5,
        unit: "degC",
      },
      11_000,
    );
    expect(reading.validity).toBe("stale");
    expect(reading.value).toBe(21.5);
    const fresh = assessObservation(
      {
        source: { deviceId: "bme280", operation: "temperature" },
        timestampMs: 1_000,
        freshnessMs: 10_000,
        value: 21.5,
      },
      10_999,
    );
    expect(fresh.validity).toBe("valid");
  });

  it("does not treat a missing sample as valid", () => {
    const missing = assessObservation(
      {
        source: { deviceId: "bme280", operation: "temperature" },
        timestampMs: 1_000,
        freshnessMs: 10_000,
        value: null,
      },
      1_000,
    );
    expect(missing.validity).toBe("missing");
    const parsed = parseObservation({ ...missing, validity: "valid" });
    expect(parsed.ok).toBe(false);
  });
});

describe("identity binding", () => {
  it("follows a replugged device and refuses a replacement on the same path", () => {
    const example = load("identity.json") as {
      configured: unknown;
      replugged: unknown;
      replaced: unknown;
    };
    const configured = parseResourceIdentity(example.configured);
    const replugged = parseResourceIdentity(example.replugged);
    const replaced = parseResourceIdentity(example.replaced);
    expect(configured.ok && replugged.ok && replaced.ok).toBe(true);
    if (!configured.ok || !replugged.ok || !replaced.ok) return;

    const rebound = bindResource(configured.value, replugged.value);
    expect(rebound).toEqual({
      ok: true,
      identity: {
        kind: "serial",
        key: "usb-serial:ABC123",
        path: "/dev/ttyACM1",
      },
    });
    const mismatch = bindResource(configured.value, replaced.value);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toMatch(/different device/);
  });

  it("rejects a path that climbs out of the device directory", () => {
    const parsed = parseResourceIdentity({
      kind: "serial",
      key: "usb-serial:ABC123",
      path: "/dev/../etc/passwd",
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("adapter contract", () => {
  it("accepts a memory adapter and rejects actuation during discovery", async () => {
    const adapter = memoryAdapter();
    const failures = await checkAdapterContract(contractInput(adapter));
    expect(failures).toEqual([]);

    const actuating = memoryAdapter({ actuateOnDiscover: true });
    const found = await checkAdapterContract(contractInput(actuating));
    expect(found).toContain("discover actuated the device");
  });
});

function contractInput(adapter: MemoryAdapter) {
  const configured: ResourceIdentity = {
    kind: "gpio",
    key: "gpio:gpiochip0:17",
    path: "gpiochip0/17",
  };
  return {
    adapter,
    configured,
    replugged: { ...configured, path: "gpiochip0/99" },
    replaced: { ...configured, key: "gpio:gpiochip0:4" },
    deviceId: "host-led",
    readOperation: "level",
    actuate: {
      commandId: "cmd-on",
      deviceId: "host-led",
      operation: "set",
      payload: true,
      deadlineMs: 1000,
      expectedState: true,
    } satisfies DeviceAction,
    unsupported: {
      commandId: "cmd-blink",
      deviceId: "host-led",
      operation: "blink",
      payload: true,
      deadlineMs: 1000,
      expectedState: true,
    } satisfies DeviceAction,
    nowMs: 5_000,
    actuationCount: () => adapter.actuationCount,
  };
}

interface MemoryAdapter extends DeviceAdapter {
  readonly actuationCount: number;
}

function memoryAdapter(options?: {
  actuateOnDiscover?: boolean;
}): MemoryAdapter {
  let actuations = 0;
  let open = false;
  const outcomes = new Map<
    string,
    {
      commandId: string;
      outcome: "confirmed" | "rejected" | "unknown";
      detail: string;
    }
  >();
  let level = false;
  return {
    get actuationCount() {
      return actuations;
    },
    async discover() {
      if (options?.actuateOnDiscover) actuations += 1;
      return [
        {
          identity: {
            kind: "gpio",
            key: "gpio:gpiochip0:17",
            path: "gpiochip0/17",
          },
          label: "led",
        },
      ];
    },
    async open(configured) {
      if (configured.key !== "gpio:gpiochip0:17") {
        return { ok: false, reason: "different device" };
      }
      open = true;
      return { ok: true };
    },
    async read(deviceId, operation, nowMs) {
      return {
        source: { deviceId, operation },
        timestampMs: nowMs,
        freshnessMs: 10_000,
        validity: open ? "valid" : "missing",
        value: open ? level : null,
      };
    },
    async execute(action) {
      if (!open)
        return {
          commandId: action.commandId,
          outcome: "rejected",
          detail: "closed",
        };
      const prior = outcomes.get(action.commandId);
      if (prior) return prior;
      if (action.operation !== "set") {
        const outcome = {
          commandId: action.commandId,
          outcome: "rejected" as const,
          detail: "unsupported operation",
        };
        outcomes.set(action.commandId, outcome);
        return outcome;
      }
      level = action.payload === true;
      actuations += 1;
      const outcome = {
        commandId: action.commandId,
        outcome: "confirmed" as const,
        detail: "set",
      };
      outcomes.set(action.commandId, outcome);
      return outcome;
    },
    async reconcile(commandId) {
      return (
        outcomes.get(commandId) ?? {
          commandId,
          outcome: "unknown" as const,
          detail: "no record of this command",
        }
      );
    },
    health() {
      return open
        ? { state: "open" as const, detail: "open" }
        : { state: "closed" as const, detail: "closed" };
    },
    async close() {
      open = false;
    },
  };
}
