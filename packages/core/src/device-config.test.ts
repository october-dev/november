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

/** A numeric output on a bus device, the kind of actuator a GPIO line cannot be. */
function dacDevice(): any {
  return {
    id: "dac",
    transport: {
      type: "spi",
      bus: 1,
      chipSelect: 0,
      mode: 0,
      maxSpeedHz: 1000000,
    },
    operations: [
      {
        name: "level",
        access: "actuate",
        value: { type: "number", unit: "%", min: 0, max: 100 },
        maxActiveMs: 60000,
      },
    ],
    safeState: { operation: "level", value: 0 },
  };
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

  it("accepts an empty device list", () => {
    expect(parseDeviceConfig({ schemaVersion: 1, devices: [] })).toEqual({
      ok: true,
      config: { schemaVersion: 1, devices: [], secrets: {} },
    });
  });

  it("rejects unknown fields once each, at every object level", () => {
    const input = example();
    input.extra = true;
    input.devices[0].note = "x";
    input.devices[0].transport.pin = 17;
    input.devices[0].operations[0].limit = 1;
    input.devices[2].operations[0].value.scale = 2;
    input.devices[0].safeState.when = "boot";
    input.devices[0].transport.also = 1;
    expect(errorsOf(input)).toEqual(
      expect.arrayContaining([
        { path: "extra", message: "is not a known field" },
        { path: "devices[0].note", message: "is not a known field" },
        { path: "devices[0].transport.pin", message: "is not a known field" },
        { path: "devices[0].transport.also", message: "is not a known field" },
        {
          path: "devices[0].operations[0].limit",
          message: "is not a known field",
        },
        {
          path: "devices[2].operations[0].value.scale",
          message: "is not a known field",
        },
        { path: "devices[0].safeState.when", message: "is not a known field" },
      ]),
    );
    expect(errorsOf(input)).toHaveLength(7);
  });

  it("reports every structural error with its path instead of stopping at the first", () => {
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

  it("checks field types and bounds, naming the field", () => {
    const cases: [string, (input: any) => void, string][] = [
      [
        "devices[0].id",
        (i) => (i.devices[0].id = "Host LED"),
        "must be lowercase letters, digits or dashes, starting with a letter",
      ],
      [
        "devices[0].transport.chip",
        (i) => (i.devices[0].transport.chip = "gpio0"),
        "must be a GPIO chip name like gpiochip0",
      ],
      [
        "devices[0].transport.type",
        (i) => (i.devices[0].transport.type = "usb"),
        'must be one of "gpio", "i2c", "spi"',
      ],
      [
        "devices[1].transport.activeLow",
        (i) => (i.devices[1].transport.activeLow = "yes"),
        "must be true or false",
      ],
      [
        "devices[1].transport.bias",
        (i) => (i.devices[1].transport.bias = "up"),
        'must be one of "disabled", "pull-up", "pull-down"',
      ],
      [
        "devices[3].transport.maxSpeedHz",
        (i) => (i.devices[3].transport.maxSpeedHz = 0),
        "must be an integer from 1 to 1000000000",
      ],
      [
        "devices[3].transport.bitsPerWord",
        (i) => (i.devices[3].transport.bitsPerWord = 33),
        "must be an integer from 1 to 32",
      ],
      [
        "devices[3].operations[0].value.maxLength",
        (i) => (i.devices[3].operations[0].value.maxLength = 4097),
        "must be an integer from 1 to 4096",
      ],
      [
        "devices[2].operations[0].value.unit",
        (i) => (i.devices[2].operations[0].value.unit = "deg C"),
        "must be a unit such as degC or hPa",
      ],
      [
        "devices[0].operations[0].access",
        (i) => (i.devices[0].operations[0].access = "write"),
        'must be one of "read", "actuate", "transfer"',
      ],
      [
        "devices[0].transport.line",
        (i) => delete i.devices[0].transport.line,
        "is required",
      ],
      ["devices", (i) => (i.devices = {}), "must be a list"],
      [
        "devices[0].transport",
        (i) => (i.devices[0].transport = "gpio"),
        "must be an object",
      ],
      [
        "devices[0].operations[0].value",
        (i) => (i.devices[0].operations[0].value = "boolean"),
        "must be an object",
      ],
    ];
    for (const [path, change, message] of cases) {
      const input = example();
      change(input);
      expect(errorsOf(input), path).toEqual([{ path, message }]);
    }
  });

  it("accepts only non-reserved 7-bit I2C addresses, reporting the bounds in hex", () => {
    for (const address of [0x07, 0x78, 118.5]) {
      const input = example();
      input.devices[2].transport.address = address;
      expect(errorsOf(input)).toEqual([
        {
          path: "devices[2].transport.address",
          message: "must be an integer from 0x08 to 0x77",
        },
      ]);
    }
    for (const address of [0x08, 0x77]) {
      const input = example();
      input.devices[2].transport.address = address;
      expect(parseDeviceConfig(input).ok).toBe(true);
    }
  });

  it("rejects an empty operation list", () => {
    const input = example();
    input.devices[1].operations = [];
    expect(errorsOf(input)).toEqual([
      { path: "devices[1].operations", message: "must be a non-empty list" },
    ]);
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

  it("rejects I2C and SPI devices that share an address or chip select", () => {
    const input = example();
    input.devices.push({ ...input.devices[2], id: "bme280-copy" });
    input.devices.push({ ...input.devices[3], id: "loopback-copy" });
    expect(errorsOf(input)).toEqual([
      {
        path: "devices[4].transport",
        message: 'i2c bus 1 address 0x76 is already used by "bme280"',
      },
      {
        path: "devices[5].transport",
        message: 'spi bus 0 chip select 0 is already used by "spi-loopback"',
      },
    ]);
  });

  it("rejects duplicate operation names on a device", () => {
    const input = example();
    input.devices[2].operations[1].name = "temperature";
    expect(errorsOf(input)).toEqual([
      {
        path: "devices[2].operations[1].name",
        message: 'duplicates operation "temperature"',
      },
    ]);
  });

  it("stages validation: domain rules run only once the structure is valid", () => {
    // An invalid transport hides a duplicate ID on the same entry until it is fixed.
    const badTransport = example();
    badTransport.devices[1].id = "host-led";
    badTransport.devices[1].transport.line = -1;
    expect(errorsOf(badTransport)).toEqual([
      {
        path: "devices[1].transport.line",
        message: "must be an integer from 0 to 65535",
      },
    ]);
    badTransport.devices[1].transport.line = 5;
    expect(errorsOf(badTransport)).toEqual([
      { path: "devices[1].id", message: "duplicates devices[0]" },
    ]);

    // An invalid operation value hides a duplicate operation name until it is fixed.
    const badValue = example();
    badValue.devices[2].operations[1].name = "temperature";
    badValue.devices[2].operations[1].value.unit = "h Pa";
    expect(errorsOf(badValue).map((e) => e.path)).toEqual([
      "devices[2].operations[1].value.unit",
    ]);
  });

  it("does not claim a device has no actuator when its actuate operation is invalid", () => {
    const input = example();
    input.devices[0].operations[0].value = { type: "bytes", maxLength: 4 };
    const errors = errorsOf(input);
    expect(errors).toEqual([
      {
        path: "devices[0].operations[0].value.type",
        message: "an actuate operation must take a boolean or number",
      },
    ]);
    expect(JSON.stringify(errors)).not.toContain("safeState");
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
    expect(errorsOf(input)).toEqual([
      {
        path: "devices[1].safeState",
        message: "applies only to devices with an actuate operation",
      },
    ]);
  });

  it("checks the safe state against its operation", () => {
    const wrongType = example();
    wrongType.devices[0].safeState.value = 0;
    expect(errorsOf(wrongType)).toEqual([
      { path: "devices[0].safeState.value", message: "must be true or false" },
    ]);

    const unknownOp = example();
    unknownOp.devices[0].safeState.operation = "blink";
    expect(errorsOf(unknownOp)).toEqual([
      {
        path: "devices[0].safeState.operation",
        message: "must name this device's actuate operation",
      },
    ]);

    const outOfRange = example();
    outOfRange.devices.push(dacDevice());
    outOfRange.devices[4].safeState.value = 101;
    expect(errorsOf(outOfRange)).toEqual([
      {
        path: "devices[4].safeState.value",
        message: "must be within the operation's min and max",
      },
    ]);
  });

  it("allows at most one actuate operation per device, so one safe state covers it", () => {
    const input = example();
    input.devices.push(dacDevice());
    input.devices[4].operations.push({
      ...input.devices[4].operations[0],
      name: "gain",
    });
    expect(errorsOf(input)).toEqual([
      {
        path: "devices[4].operations",
        message:
          "may contain at most one actuate operation, so one safe state restores the device",
      },
    ]);
  });

  it("requires every actuator to declare maxActiveMs, or the explicit exception", () => {
    const omitted = example();
    delete omitted.devices[0].operations[0].maxActiveMs;
    expect(errorsOf(omitted)).toEqual([
      { path: "devices[0].operations[0].maxActiveMs", message: "is required" },
    ]);

    for (const value of [1, 60000, 86400000, "unlimited"]) {
      const input = example();
      input.devices[0].operations[0].maxActiveMs = value;
      const result = parseDeviceConfig(input);
      expect(
        result.ok && result.config.devices[0]?.operations[0],
        String(value),
      ).toMatchObject({ maxActiveMs: value });
    }

    for (const value of [0, -5, 86400001, 1.5, "forever", null, true]) {
      const input = example();
      input.devices[0].operations[0].maxActiveMs = value;
      expect(errorsOf(input), String(value)).toEqual([
        {
          path: "devices[0].operations[0].maxActiveMs",
          message:
            'must be an integer number of milliseconds from 1 to 86400000, or "unlimited"',
        },
      ]);
    }

    const onRead = example();
    onRead.devices[1].operations[0].maxActiveMs = 1000;
    expect(errorsOf(onRead)).toEqual([
      {
        path: "devices[1].operations[0].maxActiveMs",
        message: "is not a known field",
      },
    ]);
  });

  it("keeps value types consistent with the access kind", () => {
    const transferNumber = example();
    transferNumber.devices[3].operations[0].value = {
      type: "number",
      unit: "V",
      min: 0,
      max: 1,
    };
    expect(errorsOf(transferNumber)).toEqual([
      {
        path: "devices[3].operations[0].value.type",
        message: "a transfer operation must take bytes",
      },
    ]);
  });

  it("allows only boolean read and actuate operations on a GPIO line", () => {
    const transfer = example();
    transfer.devices[1].operations[0] = {
      name: "shift",
      access: "transfer",
      value: { type: "bytes", maxLength: 4 },
    };
    expect(errorsOf(transfer)).toEqual([
      {
        path: "devices[1].operations[0].value.type",
        message: "a GPIO line supports only boolean values",
      },
    ]);

    const numeric = example();
    numeric.devices[0].operations[0].value = {
      type: "number",
      unit: "%",
      min: 0,
      max: 100,
    };
    numeric.devices[0].safeState.value = 0;
    expect(errorsOf(numeric)).toEqual([
      {
        path: "devices[0].operations[0].value.type",
        message: "a GPIO line supports only boolean values",
      },
    ]);
  });

  it("rejects number limits that are inverted or not finite", () => {
    const inverted = example();
    inverted.devices[2].operations[0].value.min = 100;
    expect(errorsOf(inverted)).toEqual([
      {
        path: "devices[2].operations[0].value.max",
        message: "must not be less than min",
      },
    ]);

    const infinite = example();
    infinite.devices[2].operations[0].value.max = Number.POSITIVE_INFINITY;
    expect(errorsOf(infinite)).toEqual([
      {
        path: "devices[2].operations[0].value.max",
        message: "must be a finite number",
      },
    ]);
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

    const badName = example();
    badName.secrets = { API_KEY: "env:PROVIDER_KEY" };
    expect(errorsOf(badName)).toEqual([
      {
        path: "secrets.API_KEY",
        message:
          "must be lowercase letters, digits or dashes, starting with a letter",
      },
    ]);
  });
});
