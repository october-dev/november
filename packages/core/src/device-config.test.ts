import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDeviceConfig, type ConfigError } from "./device-config.js";

const reference: unknown = JSON.parse(
  readFileSync(
    new URL("../examples/reference-setup.json", import.meta.url),
    "utf8",
  ),
);

/** A fresh copy of the reference example, so each test can change it freely. */
function example(): any {
  return structuredClone(reference);
}

function errorsOf(input: unknown): readonly ConfigError[] {
  const result = parseDeviceConfig(input);
  if (result.ok) throw new Error("expected the configuration to be rejected");
  return result.errors;
}

describe("parseDeviceConfig", () => {
  it("accepts the reference setup example and fills defaults", () => {
    const result = parseDeviceConfig(reference);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.config.devices.map((d) => d.id)).toEqual([
      "host-led",
      "host-button",
      "bme280",
      "spi-loopback",
    ]);
    expect(result.config.devices[0]?.transport).toEqual({
      type: "gpio",
      chip: "gpiochip0",
      line: 17,
      activeLow: false,
      bias: "disabled",
    });
    expect(result.config.devices[3]?.transport).toMatchObject({
      type: "spi",
      bitsPerWord: 8,
    });
    expect(result.config.secrets).toEqual({});
  });

  it("returns a new object and leaves the input unchanged", () => {
    const input = example();
    const before = structuredClone(input);
    const result = parseDeviceConfig(input);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.config).not.toBe(input);
    expect(result.config.devices[0]).not.toBe(input.devices[0]);
    expect(input).toEqual(before);
  });

  it("rejects input that is not an object", () => {
    expect(errorsOf(null)).toEqual([
      { path: "", message: "must be an object" },
    ]);
    expect(errorsOf([])).toEqual([{ path: "", message: "must be an object" }]);
  });

  it("rejects any schema version other than 1", () => {
    const input = example();
    input.schemaVersion = 2;
    expect(errorsOf(input)).toEqual([
      { path: "schemaVersion", message: "must be 1" },
    ]);
  });

  it("rejects unknown fields once each, at every level", () => {
    const input = example();
    input.extra = true;
    input.devices[0].transport.pin = 17;
    input.devices[0].operations[0].value.unit = "V";
    expect(errorsOf(input).map((e) => e.path)).toEqual([
      "extra",
      "devices[0].transport.pin",
      "devices[0].operations[0].value.unit",
    ]);
  });

  it("reports every error with its path instead of stopping at the first", () => {
    const input = example();
    input.devices[1].transport.line = -1;
    input.devices[2].transport.address = 0x78;
    input.devices[3].transport.mode = 4;
    expect(errorsOf(input).map((e) => e.path)).toEqual([
      "devices[1].transport.line",
      "devices[2].transport.address",
      "devices[3].transport.mode",
    ]);
  });

  it("accepts only non-reserved 7-bit I2C addresses", () => {
    for (const address of [0x07, 0x78, 118.5]) {
      const input = example();
      input.devices[2].transport.address = address;
      expect(errorsOf(input)[0]?.path).toBe("devices[2].transport.address");
    }
    for (const address of [0x08, 0x77]) {
      const input = example();
      input.devices[2].transport.address = address;
      expect(parseDeviceConfig(input).ok).toBe(true);
    }
  });

  it("rejects duplicate device IDs and two devices on one resource", () => {
    const input = example();
    input.devices[1].id = "host-led";
    input.devices[1].transport.line = 17;
    expect(errorsOf(input)).toEqual([
      { path: "devices[1].id", message: "duplicates devices[0]" },
      {
        path: "devices[1].transport",
        message: 'gpio gpiochip0 line 17 is already used by "host-led"',
      },
    ]);
  });

  it("requires a safe state for any device that can actuate", () => {
    const input = example();
    delete input.devices[0].safeState;
    expect(errorsOf(input)).toEqual([
      {
        path: "devices[0].safeState",
        message: "is required for a device with an actuate operation",
      },
    ]);
  });

  it("rejects a safe state on a device that cannot actuate", () => {
    const input = example();
    input.devices[1].safeState = { operation: "pressed", value: false };
    expect(errorsOf(input)[0]?.path).toBe("devices[1].safeState");
  });

  it("checks the safe state against its operation", () => {
    const wrongType = example();
    wrongType.devices[0].safeState.value = 0;
    expect(errorsOf(wrongType)[0]?.path).toBe("devices[0].safeState.value");

    const unknownOp = example();
    unknownOp.devices[0].safeState.operation = "blink";
    expect(errorsOf(unknownOp)[0]?.path).toBe("devices[0].safeState.operation");

    const outOfRange = example();
    outOfRange.devices[0].operations[0].value = {
      type: "number",
      unit: "%",
      min: 0,
      max: 100,
    };
    outOfRange.devices[0].safeState.value = 101;
    expect(errorsOf(outOfRange)).toEqual([
      {
        path: "devices[0].safeState.value",
        message: "must be within the operation's min and max",
      },
    ]);
  });

  it("keeps value types consistent with the access kind", () => {
    const actuateBytes = example();
    actuateBytes.devices[0].operations[0].value = {
      type: "bytes",
      maxLength: 4,
    };
    expect(errorsOf(actuateBytes).map((e) => e.path)).toContain(
      "devices[0].operations[0].value.type",
    );

    const transferNumber = example();
    transferNumber.devices[3].operations[0].value = {
      type: "number",
      unit: "V",
      min: 0,
      max: 1,
    };
    expect(errorsOf(transferNumber)[0]?.path).toBe(
      "devices[3].operations[0].value.type",
    );

    const readLimit = example();
    readLimit.devices[1].operations[0].maxActiveMs = 1000;
    expect(errorsOf(readLimit)[0]?.path).toBe(
      "devices[1].operations[0].maxActiveMs",
    );
  });

  it("rejects number limits that are inverted or not finite", () => {
    const inverted = example();
    inverted.devices[2].operations[0].value.min = 100;
    expect(errorsOf(inverted)[0]?.path).toBe(
      "devices[2].operations[0].value.max",
    );

    const infinite = example();
    infinite.devices[2].operations[0].value.max = Number.POSITIVE_INFINITY;
    expect(errorsOf(infinite)[0]?.path).toBe(
      "devices[2].operations[0].value.max",
    );
  });

  it("accepts secret references but never secret values, and does not echo them", () => {
    const valid = example();
    valid.secrets = {
      "broker-password": "file:/etc/november/broker-password",
      "api-key": "env:PROVIDER_KEY",
    };
    const ok = parseDeviceConfig(valid);
    expect(ok.ok && ok.config.secrets).toEqual(valid.secrets);

    const pasted = example();
    pasted.secrets = { "api-key": "sk-not-a-real-key-123" };
    const errors = errorsOf(pasted);
    expect(errors.map((e) => e.path)).toEqual(["secrets.api-key"]);
    expect(JSON.stringify(errors)).not.toContain("sk-not-a-real-key-123");
  });
});
