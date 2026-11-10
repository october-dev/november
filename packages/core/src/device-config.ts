/**
 * Versioned device configuration (issue #6, first checkbox).
 *
 * A configuration describes each device once: its ID, how it is wired, the
 * operations it allows with their units and limits, and the safe state of any
 * output. `parseDeviceConfig` only inspects data. It never opens, probes or
 * actuates hardware, so it is safe to run before any device is touched.
 *
 * Unknown fields are rejected rather than ignored, so a typo cannot silently
 * drop a limit. Secrets appear only as references (`env:NAME` or
 * `file:/absolute/path`), never as values.
 *
 * Not covered yet, and left to later #6 work: serial/USB identity binding,
 * observation and action types, and adapter lifecycle behavior.
 */

export const DEVICE_CONFIG_SCHEMA_VERSION = 1;

export interface GpioTransport {
  readonly type: "gpio";
  /** GPIO character device name, for example `gpiochip0`. */
  readonly chip: string;
  readonly line: number;
  readonly activeLow: boolean;
  readonly bias: "disabled" | "pull-up" | "pull-down";
}

export interface I2cTransport {
  readonly type: "i2c";
  readonly bus: number;
  /** 7-bit address outside the reserved ranges (0x08 to 0x77). */
  readonly address: number;
}

export interface SpiTransport {
  readonly type: "spi";
  readonly bus: number;
  readonly chipSelect: number;
  readonly mode: 0 | 1 | 2 | 3;
  readonly maxSpeedHz: number;
  readonly bitsPerWord: number;
}

export type Transport = GpioTransport | I2cTransport | SpiTransport;

export type OperationValue =
  | { readonly type: "boolean" }
  | {
      readonly type: "number";
      readonly unit: string;
      readonly min: number;
      readonly max: number;
    }
  | { readonly type: "bytes"; readonly maxLength: number };

/**
 * `read` observes, `actuate` changes a physical output, and `transfer` is a
 * bounded bus exchange (for example the SPI loopback) with no output.
 */
export interface Operation {
  readonly name: string;
  readonly access: "read" | "actuate" | "transfer";
  readonly value: OperationValue;
  /** Longest time an `actuate` operation may hold a non-safe value. */
  readonly maxActiveMs?: number;
}

export interface SafeState {
  readonly operation: string;
  readonly value: boolean | number;
}

export interface DeviceSpec {
  readonly id: string;
  readonly transport: Transport;
  readonly operations: readonly Operation[];
  readonly safeState?: SafeState;
}

export interface DeviceConfig {
  readonly schemaVersion: typeof DEVICE_CONFIG_SCHEMA_VERSION;
  readonly devices: readonly DeviceSpec[];
  /** Named secret references. Values are never stored here. */
  readonly secrets: Readonly<Record<string, string>>;
}

export interface ConfigError {
  /** Location of the problem, for example `devices[1].transport.address`. */
  readonly path: string;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly config: DeviceConfig }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

const ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const GPIO_CHIP_PATTERN = /^gpiochip\d+$/;
const SECRET_REF_PATTERN = /^(env:[A-Z_][A-Z0-9_]*|file:\/[^\0]+)$/;
const I2C_MIN_ADDRESS = 0x08;
const I2C_MAX_ADDRESS = 0x77;
const MAX_LINE = 65_535;
const MAX_TRANSFER_BYTES = 4096;
const MAX_ACTIVE_MS = 86_400_000;

const TRANSPORT_FIELDS = {
  gpio: ["type", "chip", "line", "activeLow", "bias"],
  i2c: ["type", "bus", "address"],
  spi: ["type", "bus", "chipSelect", "mode", "maxSpeedHz", "bitsPerWord"],
} as const;

const VALUE_FIELDS = {
  boolean: ["type"],
  number: ["type", "unit", "min", "max"],
  bytes: ["type", "maxLength"],
} as const;

type Obj = Record<string, unknown>;

class Checker {
  readonly errors: ConfigError[] = [];

  fail(path: string, message: string): undefined {
    this.errors.push({ path, message });
    return undefined;
  }

  record(value: unknown, path: string): Obj | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return this.fail(path, "must be an object");
    }
    return value as Obj;
  }

  onlyKeys(value: Obj, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key))
        this.fail(join(path, key), "is not a known field");
    }
  }

  object(
    value: unknown,
    path: string,
    allowed: readonly string[],
  ): Obj | undefined {
    const o = this.record(value, path);
    if (o) this.onlyKeys(o, path, allowed);
    return o;
  }

  int(
    value: unknown,
    path: string,
    min: number,
    max: number,
  ): number | undefined {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return this.fail(path, "must be an integer");
    }
    if (value < min || value > max) {
      return this.fail(path, `must be between ${min} and ${max}`);
    }
    return value;
  }

  finite(value: unknown, path: string): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return this.fail(path, "must be a finite number");
    }
    return value;
  }

  string(
    value: unknown,
    path: string,
    pattern: RegExp,
    hint: string,
  ): string | undefined {
    if (typeof value !== "string" || !pattern.test(value))
      return this.fail(path, hint);
    return value;
  }

  oneOf<T extends string | number>(
    value: unknown,
    path: string,
    options: readonly T[],
  ): T | undefined {
    if (!options.includes(value as T)) {
      return this.fail(
        path,
        `must be one of ${options.map((o) => JSON.stringify(o)).join(", ")}`,
      );
    }
    return value as T;
  }

  bool(value: unknown, path: string, fallback: boolean): boolean | undefined {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean")
      return this.fail(path, "must be true or false");
    return value;
  }
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function transport(
  c: Checker,
  value: unknown,
  path: string,
): Transport | undefined {
  const t = c.record(value, path);
  if (!t) return undefined;
  const type = c.oneOf(t.type, join(path, "type"), [
    "gpio",
    "i2c",
    "spi",
  ] as const);
  if (!type) return undefined;
  c.onlyKeys(t, path, TRANSPORT_FIELDS[type]);
  if (type === "gpio") {
    const chip = c.string(
      t.chip,
      join(path, "chip"),
      GPIO_CHIP_PATTERN,
      "must be a GPIO chip name like gpiochip0",
    );
    const line = c.int(t.line, join(path, "line"), 0, MAX_LINE);
    const activeLow = c.bool(t.activeLow, join(path, "activeLow"), false);
    const bias =
      t.bias === undefined
        ? "disabled"
        : c.oneOf(t.bias, join(path, "bias"), [
            "disabled",
            "pull-up",
            "pull-down",
          ] as const);
    if (
      chip === undefined ||
      line === undefined ||
      activeLow === undefined ||
      bias === undefined
    )
      return undefined;
    return { type, chip, line, activeLow, bias };
  }
  if (type === "i2c") {
    const bus = c.int(t.bus, join(path, "bus"), 0, MAX_LINE);
    const address = c.int(
      t.address,
      join(path, "address"),
      I2C_MIN_ADDRESS,
      I2C_MAX_ADDRESS,
    );
    if (bus === undefined || address === undefined) return undefined;
    return { type, bus, address };
  }
  const bus = c.int(t.bus, join(path, "bus"), 0, MAX_LINE);
  const chipSelect = c.int(t.chipSelect, join(path, "chipSelect"), 0, MAX_LINE);
  const mode = c.oneOf(t.mode, join(path, "mode"), [0, 1, 2, 3] as const);
  const maxSpeedHz = c.int(
    t.maxSpeedHz,
    join(path, "maxSpeedHz"),
    1,
    1_000_000_000,
  );
  const bitsPerWord =
    t.bitsPerWord === undefined
      ? 8
      : c.int(t.bitsPerWord, join(path, "bitsPerWord"), 1, 32);
  if (
    bus === undefined ||
    chipSelect === undefined ||
    mode === undefined ||
    maxSpeedHz === undefined ||
    bitsPerWord === undefined
  )
    return undefined;
  return { type, bus, chipSelect, mode, maxSpeedHz, bitsPerWord };
}

function operationValue(
  c: Checker,
  value: unknown,
  path: string,
): OperationValue | undefined {
  const head = c.record(value, path);
  if (!head) return undefined;
  const type = c.oneOf(head.type, join(path, "type"), [
    "boolean",
    "number",
    "bytes",
  ] as const);
  if (!type) return undefined;
  c.onlyKeys(head, path, VALUE_FIELDS[type]);
  if (type === "boolean") return { type };
  if (type === "bytes") {
    const maxLength = c.int(
      head.maxLength,
      join(path, "maxLength"),
      1,
      MAX_TRANSFER_BYTES,
    );
    return maxLength === undefined ? undefined : { type, maxLength };
  }
  const unit = c.string(
    head.unit,
    join(path, "unit"),
    /^\S{1,16}$/,
    "must be a unit such as degC or hPa",
  );
  const min = c.finite(head.min, join(path, "min"));
  const max = c.finite(head.max, join(path, "max"));
  if (min !== undefined && max !== undefined && min > max)
    return c.fail(join(path, "max"), "must not be less than min");
  if (unit === undefined || min === undefined || max === undefined)
    return undefined;
  return { type, unit, min, max };
}

function operation(
  c: Checker,
  value: unknown,
  path: string,
): Operation | undefined {
  const o = c.object(value, path, ["name", "access", "value", "maxActiveMs"]);
  if (!o) return undefined;
  const name = c.string(
    o.name,
    join(path, "name"),
    ID_PATTERN,
    "must be lowercase letters, digits or dashes, starting with a letter",
  );
  const access = c.oneOf(o.access, join(path, "access"), [
    "read",
    "actuate",
    "transfer",
  ] as const);
  const v = operationValue(c, o.value, join(path, "value"));
  if (access === "actuate" && v?.type === "bytes") {
    c.fail(
      join(path, "value.type"),
      "an actuate operation must take a boolean or number",
    );
  }
  if (access === "transfer" && v !== undefined && v.type !== "bytes") {
    c.fail(join(path, "value.type"), "a transfer operation must take bytes");
  }
  let maxActiveMs: number | undefined;
  if (o.maxActiveMs !== undefined) {
    if (access !== "actuate")
      c.fail(join(path, "maxActiveMs"), "applies only to actuate operations");
    maxActiveMs = c.int(
      o.maxActiveMs,
      join(path, "maxActiveMs"),
      1,
      MAX_ACTIVE_MS,
    );
  }
  if (name === undefined || access === undefined || v === undefined)
    return undefined;
  return maxActiveMs === undefined
    ? { name, access, value: v }
    : { name, access, value: v, maxActiveMs };
}

function safeState(
  c: Checker,
  value: unknown,
  path: string,
  operations: readonly Operation[],
): SafeState | undefined {
  const s = c.object(value, path, ["operation", "value"]);
  if (!s) return undefined;
  const op = operations.find((o) => o.name === s.operation);
  if (!op || op.access !== "actuate") {
    return c.fail(
      join(path, "operation"),
      "must name one of this device's actuate operations",
    );
  }
  if (op.value.type === "boolean") {
    return typeof s.value === "boolean"
      ? { operation: op.name, value: s.value }
      : c.fail(join(path, "value"), "must be true or false");
  }
  if (op.value.type === "number") {
    const n = c.finite(s.value, join(path, "value"));
    if (n === undefined) return undefined;
    if (n < op.value.min || n > op.value.max)
      return c.fail(
        join(path, "value"),
        "must be within the operation's min and max",
      );
    return { operation: op.name, value: n };
  }
  return undefined;
}

function device(
  c: Checker,
  value: unknown,
  path: string,
): DeviceSpec | undefined {
  const d = c.object(value, path, [
    "id",
    "transport",
    "operations",
    "safeState",
  ]);
  if (!d) return undefined;
  const id = c.string(
    d.id,
    join(path, "id"),
    ID_PATTERN,
    "must be lowercase letters, digits or dashes, starting with a letter",
  );
  const t = transport(c, d.transport, join(path, "transport"));
  const operations: Operation[] = [];
  if (!Array.isArray(d.operations) || d.operations.length === 0) {
    c.fail(join(path, "operations"), "must be a non-empty list");
  } else {
    const names = new Set<string>();
    d.operations.forEach((raw, i) => {
      const op = operation(c, raw, `${join(path, "operations")}[${i}]`);
      if (!op) return;
      if (names.has(op.name))
        c.fail(
          `${join(path, "operations")}[${i}].name`,
          `duplicates operation "${op.name}"`,
        );
      names.add(op.name);
      operations.push(op);
    });
  }
  const actuates = operations.some((o) => o.access === "actuate");
  let safe: SafeState | undefined;
  if (d.safeState === undefined) {
    if (actuates)
      c.fail(
        join(path, "safeState"),
        "is required for a device with an actuate operation",
      );
  } else if (!actuates) {
    c.fail(
      join(path, "safeState"),
      "applies only to devices with an actuate operation",
    );
  } else {
    safe = safeState(c, d.safeState, join(path, "safeState"), operations);
  }
  if (id === undefined || t === undefined) return undefined;
  return safe === undefined
    ? { id, transport: t, operations }
    : { id, transport: t, operations, safeState: safe };
}

/** One physical resource per device: two IDs must not share a line, address or chip select. */
function resourceKey(t: Transport): string {
  if (t.type === "gpio") return `gpio ${t.chip} line ${t.line}`;
  if (t.type === "i2c")
    return `i2c bus ${t.bus} address 0x${t.address.toString(16)}`;
  return `spi bus ${t.bus} chip select ${t.chipSelect}`;
}

/**
 * Validates untrusted configuration data, such as parsed JSON, and returns a
 * new, fully defaulted configuration or every problem found. It performs no
 * I/O and touches no hardware.
 */
export function parseDeviceConfig(input: unknown): ParseResult {
  const c = new Checker();
  const root = c.object(input, "", ["schemaVersion", "devices", "secrets"]);
  if (!root) return { ok: false, errors: c.errors };
  if (root.schemaVersion !== DEVICE_CONFIG_SCHEMA_VERSION) {
    c.fail("schemaVersion", `must be ${DEVICE_CONFIG_SCHEMA_VERSION}`);
  }
  const devices: DeviceSpec[] = [];
  if (!Array.isArray(root.devices)) {
    c.fail("devices", "must be a list");
  } else {
    const ids = new Map<string, number>();
    const resources = new Map<string, string>();
    root.devices.forEach((raw, i) => {
      const d = device(c, raw, `devices[${i}]`);
      if (!d) return;
      if (ids.has(d.id))
        c.fail(`devices[${i}].id`, `duplicates devices[${ids.get(d.id)}]`);
      ids.set(d.id, i);
      const key = resourceKey(d.transport);
      const owner = resources.get(key);
      if (owner !== undefined)
        c.fail(
          `devices[${i}].transport`,
          `${key} is already used by "${owner}"`,
        );
      resources.set(key, d.id);
      devices.push(d);
    });
  }
  const secrets: Record<string, string> = {};
  if (root.secrets !== undefined) {
    const s = c.record(root.secrets, "secrets");
    for (const [name, ref] of Object.entries(s ?? {})) {
      const n = c.string(
        name,
        `secrets.${name}`,
        ID_PATTERN,
        "must be lowercase letters, digits or dashes, starting with a letter",
      );
      // Never echo the value: a pasted secret must not end up in logs.
      const r = c.string(
        ref,
        `secrets.${name}`,
        SECRET_REF_PATTERN,
        "must be a reference like env:NAME or file:/absolute/path, not a secret value",
      );
      if (n !== undefined && r !== undefined) secrets[n] = r;
    }
  }
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return {
    ok: true,
    config: { schemaVersion: DEVICE_CONFIG_SCHEMA_VERSION, devices, secrets },
  };
}
