/**
 * Device policy loaded by the execution service, not by the model.
 * Parsing copies the value, so later edits to the caller's object do nothing.
 */
export interface NumberValue {
  readonly type: "number";
  readonly min: number;
  readonly max: number;
}

export interface PolicyOperation {
  readonly name: string;
  readonly access: "read" | "actuate";
  readonly value: "boolean" | NumberValue;
  readonly maxActiveMs?: number;
  readonly maxPerMinute?: number;
  readonly requiresState?: boolean | number;
}

export interface CallerGrant {
  readonly id: string;
  readonly allow: readonly {
    readonly deviceId: string;
    readonly operations: readonly string[];
  }[];
}

export interface PolicyDevice {
  readonly id: string;
  readonly operations: readonly PolicyOperation[];
}

export interface PolicyDocument {
  readonly version: number;
  readonly callers: readonly CallerGrant[];
  readonly devices: readonly PolicyDevice[];
}

export interface PolicyError {
  readonly path: string;
  readonly message: string;
}

export type PolicyResult =
  | { readonly ok: true; readonly policy: PolicyDocument }
  | { readonly ok: false; readonly errors: readonly PolicyError[] };

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const BLOCKED_NAMES = new Set(["shell", "sh", "bash", "policy", "credential"]);

export function parsePolicy(input: unknown): PolicyResult {
  if (!isRecord(input)) return fail("", "must be an object");
  const errors = unknown(input, ["version", "callers", "devices"], "");
  if (
    typeof input.version !== "number" ||
    !Number.isInteger(input.version) ||
    input.version < 1
  ) {
    errors.push({ path: "version", message: "must be an integer >= 1" });
  }
  const callerInput = input.callers;
  const deviceInput = input.devices;
  if (!Array.isArray(callerInput))
    errors.push({ path: "callers", message: "must be a list" });
  if (!Array.isArray(deviceInput))
    errors.push({ path: "devices", message: "must be a list" });
  if (
    errors.length > 0 ||
    !Array.isArray(callerInput) ||
    !Array.isArray(deviceInput)
  ) {
    return { ok: false, errors };
  }

  const callers: CallerGrant[] = [];
  callerInput.forEach((caller, index) => {
    const path = `callers[${index}]`;
    if (!isRecord(caller)) {
      errors.push({ path, message: "must be an object" });
      return;
    }
    errors.push(...unknown(caller, ["id", "allow"], path));
    if (typeof caller.id !== "string" || !NAME.test(caller.id)) {
      errors.push({
        path: `${path}.id`,
        message: "must be a lowercase identifier",
      });
    }
    if (!Array.isArray(caller.allow)) {
      errors.push({ path: `${path}.allow`, message: "must be a list" });
      return;
    }
    const allow = caller.allow.map((grant, grantIndex) => {
      const grantPath = `${path}.allow[${grantIndex}]`;
      if (!isRecord(grant)) {
        errors.push({ path: grantPath, message: "must be an object" });
        return undefined;
      }
      errors.push(...unknown(grant, ["deviceId", "operations"], grantPath));
      if (typeof grant.deviceId !== "string" || !NAME.test(grant.deviceId)) {
        errors.push({
          path: `${grantPath}.deviceId`,
          message: "must be a lowercase identifier",
        });
      }
      if (
        !Array.isArray(grant.operations) ||
        grant.operations.some((op) => typeof op !== "string" || !NAME.test(op))
      ) {
        errors.push({
          path: `${grantPath}.operations`,
          message: "must be lowercase operation names",
        });
      }
      return {
        deviceId: String(grant.deviceId),
        operations: Array.isArray(grant.operations)
          ? grant.operations.map(String)
          : [],
      };
    });
    callers.push({
      id: String(caller.id),
      allow: allow.flatMap((item) => (item ? [item] : [])),
    });
  });

  const devices: PolicyDevice[] = [];
  deviceInput.forEach((device, index) => {
    const path = `devices[${index}]`;
    if (!isRecord(device)) {
      errors.push({ path, message: "must be an object" });
      return;
    }
    errors.push(...unknown(device, ["id", "operations"], path));
    if (typeof device.id !== "string" || !NAME.test(device.id)) {
      errors.push({
        path: `${path}.id`,
        message: "must be a lowercase identifier",
      });
    }
    if (!Array.isArray(device.operations)) {
      errors.push({ path: `${path}.operations`, message: "must be a list" });
      return;
    }
    const operations: PolicyOperation[] = [];
    device.operations.forEach((operation, opIndex) => {
      const opPath = `${path}.operations[${opIndex}]`;
      const parsed = parseOperation(operation, opPath, errors);
      if (parsed) operations.push(parsed);
    });
    devices.push({ id: String(device.id), operations });
  });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    policy: structuredClone({
      version: input.version as number,
      callers,
      devices,
    }),
  };
}

export function blockedOperation(name: string): boolean {
  return BLOCKED_NAMES.has(name);
}

function parseOperation(
  input: unknown,
  path: string,
  errors: PolicyError[],
): PolicyOperation | undefined {
  if (!isRecord(input)) {
    errors.push({ path, message: "must be an object" });
    return undefined;
  }
  errors.push(
    ...unknown(
      input,
      [
        "name",
        "access",
        "value",
        "maxActiveMs",
        "maxPerMinute",
        "requiresState",
      ],
      path,
    ),
  );
  if (
    typeof input.name !== "string" ||
    !NAME.test(input.name) ||
    BLOCKED_NAMES.has(input.name)
  ) {
    errors.push({
      path: `${path}.name`,
      message: "must be a lowercase operation name",
    });
  }
  if (input.access !== "read" && input.access !== "actuate") {
    errors.push({
      path: `${path}.access`,
      message: 'must be "read" or "actuate"',
    });
  }
  let value: PolicyOperation["value"] | undefined;
  if (input.value === "boolean") value = "boolean";
  else if (isRecord(input.value)) {
    errors.push(
      ...unknown(input.value, ["type", "min", "max"], `${path}.value`),
    );
    if (
      input.value.type === "number" &&
      typeof input.value.min === "number" &&
      Number.isFinite(input.value.min) &&
      typeof input.value.max === "number" &&
      Number.isFinite(input.value.max) &&
      input.value.max >= input.value.min
    ) {
      value = { type: "number", min: input.value.min, max: input.value.max };
    } else {
      errors.push({
        path: `${path}.value`,
        message: "must be boolean or a finite number range",
      });
    }
  } else {
    errors.push({
      path: `${path}.value`,
      message: "must be boolean or a finite number range",
    });
  }
  if (
    input.maxActiveMs !== undefined &&
    !isPositiveInt(input.maxActiveMs, 86_400_000)
  ) {
    errors.push({
      path: `${path}.maxActiveMs`,
      message: "must be an integer from 1 to 86400000",
    });
  }
  if (
    input.maxPerMinute !== undefined &&
    !isPositiveInt(input.maxPerMinute, 600)
  ) {
    errors.push({
      path: `${path}.maxPerMinute`,
      message: "must be an integer from 1 to 600",
    });
  }
  if (
    input.requiresState !== undefined &&
    typeof input.requiresState !== "boolean" &&
    (typeof input.requiresState !== "number" ||
      !Number.isFinite(input.requiresState))
  ) {
    errors.push({
      path: `${path}.requiresState`,
      message: "must be a boolean or finite number",
    });
  }
  if (!value || hasError(errors, path)) return undefined;
  return {
    name: String(input.name),
    access: input.access as "read" | "actuate",
    value,
    ...(input.maxActiveMs !== undefined
      ? { maxActiveMs: input.maxActiveMs as number }
      : {}),
    ...(input.maxPerMinute !== undefined
      ? { maxPerMinute: input.maxPerMinute as number }
      : {}),
    ...(input.requiresState !== undefined
      ? { requiresState: input.requiresState as boolean | number }
      : {}),
  };
}

function hasError(errors: readonly PolicyError[], path: string): boolean {
  return errors.some(
    (error) => error.path === path || error.path.startsWith(`${path}.`),
  );
}

function isPositiveInt(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= max
  );
}

function unknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): PolicyError[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({
      path: path.length === 0 ? key : `${path}.${key}`,
      message: "is not a known field",
    }));
}

function fail(path: string, message: string): PolicyResult {
  return { ok: false, errors: [{ path, message }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
