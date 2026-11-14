/**
 * Device policy loaded by the execution service, not by the model.
 * Parsing rebuilds the value, so later edits to the caller's object
 * do nothing. Identifiers must be unambiguous: duplicate callers,
 * devices, operations, and grants are rejected, as are references to
 * devices, operations, and precondition outputs that do not exist.
 */
export interface NumberValue {
  readonly type: "number";
  readonly min: number;
  readonly max: number;
}

export interface StateRequirement {
  /** Operation on the same device whose observed value is compared. */
  readonly output: string;
  readonly equals: boolean | number;
}

export interface PolicyOperation {
  readonly name: string;
  readonly access: "read" | "actuate";
  readonly value: "boolean" | NumberValue;
  /** Actuate only: longest hold, or the explicit "unlimited" exception. */
  readonly maxActiveMs?: number | "unlimited";
  readonly maxPerMinute?: number;
  readonly requiresState?: StateRequirement;
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
  const callerIds = new Set<string>();
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
    } else if (callerIds.has(caller.id)) {
      errors.push({
        path: `${path}.id`,
        message: "caller id is already defined",
      });
    } else {
      callerIds.add(caller.id);
    }
    if (!Array.isArray(caller.allow)) {
      errors.push({ path: `${path}.allow`, message: "must be a list" });
      return;
    }
    const deviceIds = new Set<string>();
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
      } else if (deviceIds.has(grant.deviceId)) {
        errors.push({
          path: `${grantPath}.deviceId`,
          message: "device is already granted to this caller",
        });
      } else {
        deviceIds.add(grant.deviceId);
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
  const deviceIds = new Set<string>();
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
    } else if (deviceIds.has(device.id)) {
      errors.push({
        path: `${path}.id`,
        message: "device id is already defined",
      });
    } else {
      deviceIds.add(device.id);
    }
    if (!Array.isArray(device.operations)) {
      errors.push({ path: `${path}.operations`, message: "must be a list" });
      return;
    }
    const operations: PolicyOperation[] = [];
    const names = new Set<string>();
    device.operations.forEach((operation, opIndex) => {
      const opPath = `${path}.operations[${opIndex}]`;
      if (
        isRecord(operation) &&
        typeof operation.name === "string" &&
        NAME.test(operation.name)
      ) {
        if (names.has(operation.name)) {
          errors.push({
            path: `${opPath}.name`,
            message: "operation name is already defined on this device",
          });
        } else {
          names.add(operation.name);
        }
      }
      const parsed = parseOperation(operation, opPath, errors);
      if (parsed) operations.push(parsed);
    });
    devices.push({ id: String(device.id), operations });
  });

  if (errors.length === 0) {
    errors.push(...checkReferences(callers, devices));
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    policy: {
      version: input.version as number,
      callers,
      devices,
    },
  };
}

function checkReferences(
  callers: readonly CallerGrant[],
  devices: readonly PolicyDevice[],
): PolicyError[] {
  const errors: PolicyError[] = [];
  const byId = new Map(devices.map((device) => [device.id, device]));
  callers.forEach((caller, callerIndex) => {
    caller.allow.forEach((grant, grantIndex) => {
      const grantPath = `callers[${callerIndex}].allow[${grantIndex}]`;
      const device = byId.get(grant.deviceId);
      if (!device) {
        errors.push({
          path: `${grantPath}.deviceId`,
          message: "device is not defined",
        });
        return;
      }
      const names = new Set(device.operations.map((op) => op.name));
      grant.operations.forEach((name, opIndex) => {
        if (!names.has(name)) {
          errors.push({
            path: `${grantPath}.operations[${opIndex}]`,
            message: "operation is not defined on this device",
          });
        }
      });
    });
  });
  devices.forEach((device, deviceIndex) => {
    device.operations.forEach((operation, opIndex) => {
      const required = operation.requiresState;
      if (!required) return;
      const target = device.operations.find(
        (op) => op.name === required.output,
      );
      const base = `devices[${deviceIndex}].operations[${opIndex}].requiresState`;
      if (!target) {
        errors.push({
          path: `${base}.output`,
          message: "operation is not defined on this device",
        });
        return;
      }
      if (target.value === "boolean" && typeof required.equals !== "boolean") {
        errors.push({
          path: `${base}.equals`,
          message: "must be a boolean for a boolean output",
        });
      } else if (
        target.value !== "boolean" &&
        (typeof required.equals !== "number" ||
          required.equals < target.value.min ||
          required.equals > target.value.max)
      ) {
        errors.push({
          path: `${base}.equals`,
          message: `must be a number from ${target.value.min} to ${target.value.max}`,
        });
      }
    });
  });
  return errors;
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
  if (typeof input.name !== "string" || !NAME.test(input.name)) {
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
  const access = input.access as "read" | "actuate" | undefined;
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
  let maxActiveMs: number | "unlimited" | undefined;
  if (input.maxActiveMs === "unlimited") {
    maxActiveMs = "unlimited";
  } else if (input.maxActiveMs !== undefined) {
    if (!isPositiveInt(input.maxActiveMs, 86_400_000)) {
      errors.push({
        path: `${path}.maxActiveMs`,
        message: 'must be an integer from 1 to 86400000, or "unlimited"',
      });
    } else {
      maxActiveMs = input.maxActiveMs;
    }
  }
  if (access === "actuate" && input.maxActiveMs === undefined) {
    errors.push({
      path: `${path}.maxActiveMs`,
      message: 'is required: an integer from 1 to 86400000, or "unlimited"',
    });
  }
  if (access === "read" && input.maxActiveMs !== undefined) {
    errors.push({
      path: `${path}.maxActiveMs`,
      message: "does not apply to a read operation",
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
  let requiresState: StateRequirement | undefined;
  if (input.requiresState !== undefined) {
    requiresState = parseRequirement(input.requiresState, path, errors);
  }
  if (!value || hasError(errors, path)) return undefined;
  return {
    name: String(input.name),
    access: access as "read" | "actuate",
    value,
    ...(maxActiveMs !== undefined ? { maxActiveMs } : {}),
    ...(input.maxPerMinute !== undefined
      ? { maxPerMinute: input.maxPerMinute as number }
      : {}),
    ...(requiresState ? { requiresState } : {}),
  };
}

function parseRequirement(
  input: unknown,
  path: string,
  errors: PolicyError[],
): StateRequirement | undefined {
  const where = `${path}.requiresState`;
  if (!isRecord(input)) {
    errors.push({ path: where, message: "must be an object" });
    return undefined;
  }
  errors.push(...unknown(input, ["output", "equals"], where));
  if (typeof input.output !== "string" || !NAME.test(input.output)) {
    errors.push({
      path: `${where}.output`,
      message: "must be a lowercase operation name",
    });
  }
  if (
    typeof input.equals !== "boolean" &&
    (typeof input.equals !== "number" || !Number.isFinite(input.equals))
  ) {
    errors.push({
      path: `${where}.equals`,
      message: "must be a boolean or finite number",
    });
  }
  if (hasError(errors, where)) return undefined;
  return {
    output: input.output as string,
    equals: input.equals as boolean | number,
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
