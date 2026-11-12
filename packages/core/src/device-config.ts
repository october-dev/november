/**
 * Versioned device configuration (issue #6, first checkbox).
 *
 * A configuration describes each device once: its ID, how it is wired, the
 * operations it allows with their units and limits, and the safe state of its
 * output. `parseDeviceConfig` only inspects data. It never opens, probes or
 * actuates hardware, so it is safe to run before any device is touched.
 *
 * Validation is staged. The schema below checks structure first and reports
 * every structural problem. Only when the structure is valid do the domain
 * rules run (safe states, duplicates, shared resources, supported
 * combinations), and they report every domain problem. A structural error
 * therefore never produces a domain conclusion, such as a missing actuator,
 * about an entry that did not parse.
 *
 * Driver selection: `transport.type` selects the adapter family. A GPIO device
 * is one line, so it supports only boolean `read` or `actuate` operations; the
 * domain rules reject numbers and transfers on it. Values are logical: `true`
 * means asserted, and `activeLow: true` makes asserted a low electrical level.
 * I2C and SPI operations depend on the attached chip, so those devices will
 * name their driver in the adapter-contract part of #6, and the adapter must
 * reject any operation it does not implement before opening hardware.
 *
 * Safe state: a device may have at most one `actuate` operation, so its single
 * `safeState` restores the whole device. Every actuator declares `maxActiveMs`,
 * either a bounded duration or the explicit exception "unlimited"; an exception
 * records intent and does not establish that a physical load is safe.
 * `transfer` operations are not actuations and need no safe state, but bytes
 * written to a bus device can change its state; use them only for exchanges
 * whose effect is understood, such as the reference SPI loopback.
 *
 * Secrets appear only as references (`env:NAME` or `file:/absolute/path`),
 * never as values. This parser checks their syntax only: it does not resolve
 * them, read environment variables or check that a file exists or is
 * readable. Lookup and path rules belong to the component that consumes them.
 *
 * Not covered yet, and left to later #6 work: identity binding for every
 * resource (serial/USB, MQTT, and GPIO, I2C and SPI devices that can be
 * renumbered), observation and action types, and adapter lifecycle behavior.
 */
import { z } from "zod";

export const DEVICE_CONFIG_SCHEMA_VERSION = 1;

const ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const GPIO_CHIP_PATTERN = /^gpiochip\d+$/;
const SECRET_REF_PATTERN = /^(env:[A-Z_][A-Z0-9_]*|file:\/[^\0]+)$/;
const I2C_MIN_ADDRESS = 0x08;
const I2C_MAX_ADDRESS = 0x77;
const MAX_LINE = 65_535;
const MAX_TRANSFER_BYTES = 4096;
const MAX_ACTIVE_MS = 86_400_000;
const MAX_ACTIVE_MESSAGE = `must be an integer number of milliseconds from 1 to ${MAX_ACTIVE_MS}, or "unlimited"`;
const ID_MESSAGE =
  "must be lowercase letters, digits or dashes, starting with a letter";

/** Every message says what is wrong; a missing field says so instead. */
const says = (message: string) => ({
  error: (issue: { input: unknown }) =>
    issue.input === undefined ? "is required" : message,
});

/** Like `says`, for a tagged object: a value that is not an object says so. */
const saysTagged = (message: string) => ({
  error: (issue: { input: unknown; code: string }) => {
    if (issue.input === undefined) return "is required";
    return issue.code === "invalid_type" ? "must be an object" : message;
  },
});

const integer = (min: number, max: number, message?: string) => {
  const text = message ?? `must be an integer from ${min} to ${max}`;
  return z
    .number(says(text))
    .int(says(text))
    .min(min, says(text))
    .max(max, says(text));
};

const Id = z.string(says(ID_MESSAGE)).regex(ID_PATTERN, says(ID_MESSAGE));

const GpioTransportSchema = z.strictObject({
  type: z.literal("gpio"),
  /** GPIO character device name, for example `gpiochip0`. */
  chip: z
    .string(says("must be a GPIO chip name like gpiochip0"))
    .regex(GPIO_CHIP_PATTERN, says("must be a GPIO chip name like gpiochip0")),
  line: integer(0, MAX_LINE),
  activeLow: z.boolean(says("must be true or false")).default(false),
  bias: z
    .enum(
      ["disabled", "pull-up", "pull-down"],
      says('must be one of "disabled", "pull-up", "pull-down"'),
    )
    .default("disabled"),
});

const I2cTransportSchema = z.strictObject({
  type: z.literal("i2c"),
  bus: integer(0, MAX_LINE),
  /** 7-bit address outside the reserved ranges. */
  address: integer(
    I2C_MIN_ADDRESS,
    I2C_MAX_ADDRESS,
    "must be an integer from 0x08 to 0x77",
  ),
});

const SpiTransportSchema = z.strictObject({
  type: z.literal("spi"),
  bus: integer(0, MAX_LINE),
  chipSelect: integer(0, MAX_LINE),
  mode: integer(0, 3),
  maxSpeedHz: integer(1, 1_000_000_000),
  bitsPerWord: integer(1, 32).default(8),
});

const TransportSchema = z.discriminatedUnion(
  "type",
  [GpioTransportSchema, I2cTransportSchema, SpiTransportSchema],
  saysTagged('must be one of "gpio", "i2c", "spi"'),
);

const BooleanValue = z.strictObject({ type: z.literal("boolean") });
const NumberValue = z
  .strictObject({
    type: z.literal("number"),
    unit: z
      .string(says("must be a unit such as degC or hPa"))
      .regex(/^\S{1,16}$/, says("must be a unit such as degC or hPa")),
    min: z.number(says("must be a finite number")),
    max: z.number(says("must be a finite number")),
  })
  .refine((value) => value.min <= value.max, {
    path: ["max"],
    error: "must not be less than min",
  });
const BytesValue = z.strictObject({
  type: z.literal("bytes"),
  maxLength: integer(1, MAX_TRANSFER_BYTES),
});

const OperationSchema = z.discriminatedUnion(
  "access",
  [
    z.strictObject({
      name: Id,
      access: z.literal("read"),
      value: z.discriminatedUnion(
        "type",
        [BooleanValue, NumberValue, BytesValue],
        saysTagged('must be one of "boolean", "number", "bytes"'),
      ),
    }),
    z.strictObject({
      name: Id,
      access: z.literal("actuate"),
      value: z.discriminatedUnion(
        "type",
        [BooleanValue, NumberValue],
        saysTagged("an actuate operation must take a boolean or number"),
      ),
      /** Longest time the output may hold a non-safe value, or the explicit exception "unlimited". */
      maxActiveMs: z.union(
        [integer(1, MAX_ACTIVE_MS, MAX_ACTIVE_MESSAGE), z.literal("unlimited")],
        says(MAX_ACTIVE_MESSAGE),
      ),
    }),
    z.strictObject({
      name: Id,
      access: z.literal("transfer"),
      value: z.discriminatedUnion(
        "type",
        [BytesValue],
        saysTagged("a transfer operation must take bytes"),
      ),
    }),
  ],
  saysTagged('must be one of "read", "actuate", "transfer"'),
);

const SafeStateSchema = z.strictObject(
  {
    operation: Id,
    value: z.union(
      [z.boolean(), z.number()],
      says("must be true, false or a finite number"),
    ),
  },
  says("must be an object"),
);

const DeviceSchema = z.strictObject(
  {
    id: Id,
    transport: TransportSchema,
    operations: z
      .array(OperationSchema, says("must be a non-empty list"))
      .min(1, says("must be a non-empty list")),
    safeState: SafeStateSchema.optional(),
  },
  says("must be an object"),
);

const DeviceConfigSchema = z.strictObject(
  {
    schemaVersion: z.literal(
      DEVICE_CONFIG_SCHEMA_VERSION,
      says(`must be ${DEVICE_CONFIG_SCHEMA_VERSION}`),
    ),
    devices: z.array(DeviceSchema, says("must be a list")),
    /** Named secret references. Values are never stored here. */
    secrets: z
      .record(
        Id,
        // Never echo the value: a pasted secret must not end up in logs.
        z
          .string(
            says(
              "must be a reference like env:NAME or file:/absolute/path, not a secret value",
            ),
          )
          .regex(
            SECRET_REF_PATTERN,
            says(
              "must be a reference like env:NAME or file:/absolute/path, not a secret value",
            ),
          ),
        {
          // The record also reports a bad name, which needs the name wording.
          error: (issue: { code: string }) =>
            issue.code === "invalid_key" ? ID_MESSAGE : "must be an object",
        },
      )
      .default({}),
  },
  says("must be an object"),
);

export type DeviceConfig = z.output<typeof DeviceConfigSchema>;
export type DeviceSpec = DeviceConfig["devices"][number];
export type Transport = DeviceSpec["transport"];
export type GpioTransport = Extract<Transport, { type: "gpio" }>;
export type I2cTransport = Extract<Transport, { type: "i2c" }>;
export type SpiTransport = Extract<Transport, { type: "spi" }>;
export type Operation = DeviceSpec["operations"][number];
export type OperationValue = Operation["value"];
export type SafeState = NonNullable<DeviceSpec["safeState"]>;

export interface ConfigError {
  /** Location of the problem, for example `devices[1].transport.address`. */
  readonly path: string;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly config: DeviceConfig }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

function pathText(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, key) => {
    if (typeof key === "number") return `${text}[${key}]`;
    return text ? `${text}.${String(key)}` : String(key);
  }, "");
}

/** One error per problem; an unknown-key issue lists keys, so it becomes one error per field. */
function structuralErrors(issues: readonly z.core.$ZodIssue[]): ConfigError[] {
  return issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => ({
          path: pathText([...issue.path, key]),
          message: "is not a known field",
        }))
      : [{ path: pathText(issue.path), message: issue.message }],
  );
}

/** One physical resource per device: two IDs must not share a line, address or chip select. */
function resourceKey(t: Transport): string {
  if (t.type === "gpio") return `gpio ${t.chip} line ${t.line}`;
  if (t.type === "i2c")
    return `i2c bus ${t.bus} address 0x${t.address.toString(16)}`;
  return `spi bus ${t.bus} chip select ${t.chipSelect}`;
}

function safeStateErrors(device: DeviceSpec, path: string): ConfigError[] {
  const actuator = device.operations.find((op) => op.access === "actuate");
  if (!device.safeState) {
    return actuator
      ? [
          {
            path: `${path}.safeState`,
            message: "is required for a device with an actuate operation",
          },
        ]
      : [];
  }
  if (!actuator) {
    return [
      {
        path: `${path}.safeState`,
        message: "applies only to devices with an actuate operation",
      },
    ];
  }
  if (device.safeState.operation !== actuator.name) {
    return [
      {
        path: `${path}.safeState.operation`,
        message: "must name this device's actuate operation",
      },
    ];
  }
  const value = device.safeState.value;
  if (actuator.value.type === "boolean" && typeof value !== "boolean") {
    return [
      { path: `${path}.safeState.value`, message: "must be true or false" },
    ];
  }
  if (actuator.value.type === "number") {
    if (typeof value !== "number") {
      return [
        { path: `${path}.safeState.value`, message: "must be a finite number" },
      ];
    }
    if (value < actuator.value.min || value > actuator.value.max) {
      return [
        {
          path: `${path}.safeState.value`,
          message: "must be within the operation's min and max",
        },
      ];
    }
  }
  return [];
}

/** Rules that need a structurally valid configuration; each problem is reported. */
function domainErrors(config: DeviceConfig): ConfigError[] {
  const errors: ConfigError[] = [];
  const ids = new Map<string, number>();
  const resources = new Map<string, string>();
  config.devices.forEach((device, i) => {
    const path = `devices[${i}]`;
    const first = ids.get(device.id);
    if (first !== undefined)
      errors.push({
        path: `${path}.id`,
        message: `duplicates devices[${first}]`,
      });
    else ids.set(device.id, i);

    const key = resourceKey(device.transport);
    const owner = resources.get(key);
    if (owner !== undefined)
      errors.push({
        path: `${path}.transport`,
        message: `${key} is already used by "${owner}"`,
      });
    else resources.set(key, device.id);

    const names = new Set<string>();
    let actuators = 0;
    device.operations.forEach((op, j) => {
      const opPath = `${path}.operations[${j}]`;
      if (names.has(op.name))
        errors.push({
          path: `${opPath}.name`,
          message: `duplicates operation "${op.name}"`,
        });
      names.add(op.name);
      if (op.access === "actuate") actuators++;
      if (device.transport.type === "gpio" && op.value.type !== "boolean")
        errors.push({
          path: `${opPath}.value.type`,
          message: "a GPIO line supports only boolean values",
        });
    });
    if (actuators > 1)
      errors.push({
        path: `${path}.operations`,
        message:
          "may contain at most one actuate operation, so one safe state restores the device",
      });
    else errors.push(...safeStateErrors(device, path));
  });
  return errors;
}

/**
 * Validates untrusted configuration data, such as parsed JSON, and returns a
 * new, fully defaulted configuration, or the problems found. Structural
 * problems are all reported first; domain problems are reported only for a
 * structurally valid configuration. It performs no I/O and touches no hardware.
 */
export function parseDeviceConfig(input: unknown): ParseResult {
  const parsed = DeviceConfigSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, errors: structuralErrors(parsed.error.issues) };
  const errors = domainErrors(parsed.data);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: parsed.data };
}
