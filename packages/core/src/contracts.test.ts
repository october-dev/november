import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessObservation,
  bindResource,
  checkAdapterContract,
  parseDeviceAction,
  parseObservation,
  parseResourceIdentity,
  type AdapterOutcome,
  type DeviceAction,
  type DeviceAdapter,
  type Observation,
  type ResourceIdentity,
} from "./index.js";

function load(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

function assessed(input: unknown, nowMs: number): Observation {
  const result = assessObservation(input, nowMs);
  if (!result.ok) {
    throw new Error(
      `expected an assessed observation: ${JSON.stringify(result.errors)}`,
    );
  }
  return result.value;
}

function failed(input: unknown, nowMs: number): string {
  const result = assessObservation(input, nowMs);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected assessment errors");
  return result.errors
    .map((error) => `${error.path} ${error.message}`)
    .join("; ");
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
    const reading = assessed(
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
    const fresh = assessed(
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
    const missing = assessed(
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

  it("preserves invalid and missing status on reassessment", () => {
    const sample = {
      source: { deviceId: "bme280", operation: "temperature" },
      timestampMs: 1_000,
      freshnessMs: 10_000,
      value: 21.5,
    };
    const invalid = assessed({ ...sample, invalid: true }, 1_001);
    expect(invalid.validity).toBe("invalid");
    expect(invalid.value).toBe(21.5);
    // A numeric value in an invalid record must not become valid by recency.
    const again = assessed(invalid, 1_002);
    expect(again.validity).toBe("invalid");
    expect(again.value).toBe(21.5);

    const stored = assessed(
      { ...sample, validity: "invalid", value: 21.5 },
      1_001,
    );
    expect(stored.validity).toBe("invalid");
    const restored = assessed(stored, 1_002);
    expect(restored.validity).toBe("invalid");

    const missing = assessed({ ...sample, value: null }, 1_000);
    expect(missing.validity).toBe("missing");
    expect(assessed(missing, 1_001).validity).toBe("missing");
  });

  it("rejects malformed assessment input instead of repairing it", () => {
    const sample = {
      source: { deviceId: "bme280", operation: "temperature" },
      timestampMs: 1_000,
      freshnessMs: 10_000,
      value: 21.5,
    };
    expect(failed({ ...sample, timestampMs: -1 }, 1_000)).toMatch(
      /timestampMs/,
    );
    expect(failed({ ...sample, freshnessMs: 0 }, 1_000)).toMatch(/freshnessMs/);
    expect(
      failed(
        { ...sample, source: { deviceId: "BME", operation: "temperature" } },
        1_000,
      ),
    ).toMatch(/source\.deviceId/);
    expect(failed({ ...sample, unit: "has space" }, 1_000)).toMatch(/unit/);
    expect(failed({ ...sample, value: Number.NaN }, 1_000)).toMatch(/value/);
    expect(failed(sample, Number.NaN)).toMatch(/nowMs/);
    expect(failed(sample, 999)).toMatch(/predates/);
    expect(
      failed({ ...sample, validity: "valid", invalid: true }, 1_000),
    ).toMatch(/must not both be present/);
    expect(failed({ ...sample, note: 1 }, 1_000)).toMatch(/not a known field/);
  });

  it("round-trips every assessed observation through the parser", () => {
    const samples: Array<[unknown, number]> = [
      [
        {
          source: { deviceId: "bme280", operation: "temperature" },
          timestampMs: 1_000,
          freshnessMs: 10_000,
          value: 21.5,
          unit: "degC",
        },
        5_000,
      ],
      [
        {
          source: { deviceId: "bme280", operation: "temperature" },
          timestampMs: 1_000,
          freshnessMs: 10_000,
          value: 21.5,
        },
        11_000,
      ],
      [
        {
          source: { deviceId: "bme280", operation: "temperature" },
          timestampMs: 1_000,
          freshnessMs: 10_000,
          value: null,
        },
        1_000,
      ],
      [
        {
          source: { deviceId: "bme280", operation: "temperature" },
          timestampMs: 1_000,
          freshnessMs: 10_000,
          value: 21.5,
          invalid: true,
        },
        1_001,
      ],
      [
        {
          source: { deviceId: "spi-loopback", operation: "transfer" },
          timestampMs: 2_000,
          freshnessMs: 10_000,
          value: { type: "bytes", base64: "aGk=" },
        },
        2_500,
      ],
    ];
    for (const [input, nowMs] of samples) {
      const result = assessObservation(input, nowMs);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(parseObservation(result.value).ok).toBe(true);
    }
  });

  it("represents byte transfer results as observations", () => {
    const parsed = parseObservation({
      source: { deviceId: "spi-loopback", operation: "transfer" },
      timestampMs: 2_000,
      freshnessMs: 10_000,
      validity: "valid",
      value: { type: "bytes", base64: "aGk=" },
    });
    expect(parsed.ok).toBe(true);
    const bad = parseObservation({
      source: { deviceId: "spi-loopback", operation: "transfer" },
      timestampMs: 2_000,
      freshnessMs: 10_000,
      validity: "valid",
      value: { type: "bytes", base64: "not base64!!" },
    });
    expect(bad.ok).toBe(false);
  });

  it("shares identifier and unit rules with the device configuration", () => {
    const longId = `a${"b".repeat(62)}`;
    expect(longId.length).toBe(63);
    const action = parseDeviceAction({
      commandId: longId,
      deviceId: "host-led",
      operation: "set",
      payload: true,
      deadlineMs: 1000,
      expectedState: true,
    });
    expect(action.ok).toBe(true);
    const tooLong = parseDeviceAction({
      commandId: `${longId}c`,
      deviceId: "host-led",
      operation: "set",
      payload: true,
      deadlineMs: 1000,
      expectedState: true,
    });
    expect(tooLong.ok).toBe(false);
    for (const unit of ["degC", "hPa", "°C", "µT", "Ω", "m/s^2"]) {
      const reading = parseObservation({
        source: { deviceId: "bme280", operation: "temperature" },
        timestampMs: 1_000,
        freshnessMs: 10_000,
        validity: "valid",
        value: 21.5,
        unit,
      });
      expect(reading.ok, unit).toBe(true);
    }
    expect(
      parseObservation({
        source: { deviceId: "bme280", operation: "temperature" },
        timestampMs: 1_000,
        freshnessMs: 10_000,
        validity: "valid",
        value: 21.5,
        unit: "a".repeat(17),
      }).ok,
    ).toBe(false);
  });

  it("validates actions with field-specific diagnostics", () => {
    const result = parseDeviceAction({
      commandId: "Bad Id",
      deviceId: "host-led",
      operation: "set",
      payload: Number.NaN,
      deadlineMs: 0,
      expectedState: "x".repeat(1025),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.errors.map((error) => error.path).sort();
    expect(paths).toEqual([
      "commandId",
      "deadlineMs",
      "expectedState",
      "payload",
    ]);
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

  it("lets an uncertain action stay unknown without further evidence", async () => {
    const adapter = scriptedAdapter({
      executeOutcome: "unknown",
      actuated: true,
      reconcileOutcomes: ["unknown", "unknown"],
    });
    const failures = await checkAdapterContract(contractInput(adapter));
    expect(failures).toEqual([]);
    expect(adapter.actuationCount).toBe(1);
  });

  it("reconciles an uncertain action to confirmed without a second actuation", async () => {
    const adapter = scriptedAdapter({
      executeOutcome: "unknown",
      actuated: true,
      reconcileOutcomes: ["unknown", "confirmed"],
    });
    const input = contractInput(adapter);
    const failures = await checkAdapterContract(input);
    expect(failures).toEqual([]);
    // Execute actuated once; reconcile and the duplicate must not repeat it.
    expect(adapter.actuationCount).toBe(1);
    // Later evidence reconciles the same command to confirmed.
    const updated = await adapter.reconcile(input.actuate.commandId);
    expect(updated.outcome).toBe("confirmed");
    expect(adapter.actuationCount).toBe(1);
    const duplicate = await adapter.execute(input.actuate, input.nowMs);
    expect(duplicate.outcome).toBe("confirmed");
    expect(adapter.actuationCount).toBe(1);
  });

  it("handles an evidenced failure without actuating", async () => {
    const adapter = scriptedAdapter({
      executeOutcome: "failed",
      actuated: false,
      reconcileOutcomes: ["failed"],
    });
    const failures = await checkAdapterContract(contractInput(adapter));
    expect(failures).toEqual([]);
    expect(adapter.actuationCount).toBe(0);
  });

  it("fails an adapter that ignores device ids", async () => {
    const adapter = scriptedAdapter({
      executeOutcome: "confirmed",
      actuated: true,
      reconcileOutcomes: ["confirmed"],
      ignoreDeviceIds: true,
    });
    const failures = await checkAdapterContract(contractInput(adapter));
    expect(failures).toContain("read reported foreign data as valid");
    expect(failures).toContain("execute admitted a foreign device");
  });

  it("fails an adapter that returns observations the parser rejects", async () => {
    const adapter = scriptedAdapter({
      executeOutcome: "confirmed",
      actuated: true,
      reconcileOutcomes: ["confirmed"],
      malformedReadings: true,
    });
    const failures = await checkAdapterContract(contractInput(adapter));
    expect(
      failures.some((failure) =>
        failure.startsWith("read returned an observation the parser rejects"),
      ),
    ).toBe(true);
  });
});

function contractInput(adapter: MemoryAdapter) {
  const configured: ResourceIdentity = {
    kind: "gpio",
    key: "gpio:gpiochip0:17",
    path: "gpiochip0/17",
  };
  const actuate: DeviceAction = {
    commandId: "cmd-on",
    deviceId: "host-led",
    operation: "set",
    payload: true,
    deadlineMs: 1000,
    expectedState: true,
  };
  return {
    adapter,
    configured,
    replugged: { ...configured, path: "gpiochip0/99" },
    replaced: { ...configured, key: "gpio:gpiochip0:4" },
    deviceId: "host-led",
    readOperation: "level",
    foreignDeviceId: "other-led",
    actuate,
    actuateFresh: { ...actuate, commandId: "cmd-fresh" },
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
  const outcomes = new Map<string, AdapterOutcome>();
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
      return { ok: true, identity: configured };
    },
    async read(deviceId, operation, nowMs) {
      if (!open || deviceId !== "host-led") {
        return {
          source: { deviceId, operation },
          timestampMs: nowMs,
          freshnessMs: 10_000,
          validity: "missing" as const,
          value: null,
        };
      }
      return {
        source: { deviceId, operation },
        timestampMs: nowMs,
        freshnessMs: 10_000,
        validity: "valid" as const,
        value: level,
      };
    },
    async execute(action) {
      const prior = outcomes.get(action.commandId);
      if (prior) return prior;
      if (!open) {
        return {
          commandId: action.commandId,
          outcome: "rejected" as const,
          detail: "closed",
        };
      }
      if (action.deviceId !== "host-led" || action.operation !== "set") {
        const outcome: AdapterOutcome = {
          commandId: action.commandId,
          outcome: "rejected",
          detail: "unsupported operation",
        };
        outcomes.set(action.commandId, outcome);
        return outcome;
      }
      level = action.payload === true;
      actuations += 1;
      const outcome: AdapterOutcome = {
        commandId: action.commandId,
        outcome: "confirmed",
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

function scriptedAdapter(options: {
  executeOutcome: "confirmed" | "failed" | "unknown";
  actuated: boolean;
  reconcileOutcomes: Array<"confirmed" | "failed" | "unknown">;
  ignoreDeviceIds?: boolean;
  malformedReadings?: boolean;
}): MemoryAdapter & { actuationCount: number } {
  let actuations = 0;
  let open = false;
  let reconciles = 0;
  const outcomes = new Map<string, AdapterOutcome>();
  const base = memoryAdapter();
  const adapter: MemoryAdapter = {
    get actuationCount() {
      return actuations;
    },
    discover: () => base.discover(),
    open: async (configured) => {
      const result = await base.open(configured);
      open = result.ok;
      return result;
    },
    read: async (deviceId, operation, nowMs) => {
      if (options.malformedReadings) {
        return {
          source: { deviceId, operation },
          timestampMs: nowMs,
          freshnessMs: 10_000,
          validity: "valid" as const,
          value: null,
        };
      }
      if (!options.ignoreDeviceIds && (!open || deviceId !== "host-led")) {
        return {
          source: { deviceId, operation },
          timestampMs: nowMs,
          freshnessMs: 10_000,
          validity: "missing" as const,
          value: null,
        };
      }
      return {
        source: { deviceId, operation },
        timestampMs: nowMs,
        freshnessMs: 10_000,
        validity: "valid" as const,
        value: true,
      };
    },
    execute: async (action) => {
      const prior = outcomes.get(action.commandId);
      if (prior) return prior;
      if (!open) {
        return {
          commandId: action.commandId,
          outcome: "rejected" as const,
          detail: "closed",
        };
      }
      if (
        !options.ignoreDeviceIds &&
        (action.deviceId !== "host-led" || action.operation !== "set")
      ) {
        const outcome: AdapterOutcome = {
          commandId: action.commandId,
          outcome: "rejected",
          detail: "unsupported operation",
        };
        outcomes.set(action.commandId, outcome);
        return outcome;
      }
      if (options.actuated) actuations += 1;
      const outcome: AdapterOutcome = {
        commandId: action.commandId,
        outcome: options.executeOutcome,
        detail: options.executeOutcome,
      };
      outcomes.set(action.commandId, outcome);
      return outcome;
    },
    reconcile: async (commandId) => {
      const stored = outcomes.get(commandId);
      if (!stored) {
        return {
          commandId,
          outcome: "unknown" as const,
          detail: "no record of this command",
        };
      }
      if (stored.outcome !== "unknown") return stored;
      const next =
        options.reconcileOutcomes[
          Math.min(reconciles, options.reconcileOutcomes.length - 1)
        ] ?? "unknown";
      reconciles += 1;
      const updated: AdapterOutcome = {
        commandId,
        outcome: next,
        detail: next,
      };
      outcomes.set(commandId, updated);
      return updated;
    },
    health: () => base.health(),
    close: async () => {
      open = false;
      await base.close();
    },
  };
  return adapter;
}
