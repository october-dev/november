/**
 * A reading from one device operation.
 *
 * Freshness is a limit on age, not a promise that the sensor is still
 * connected. Callers pass `nowMs` from their own clock. Read-only reference
 * devices are stale 10 seconds after the last valid sample
 * (docs/support-matrix.md, safe states).
 */
import {
  checkName,
  isRecord,
  unknownFieldErrors,
  type FieldError,
  type ParseResult,
} from "./fields.js";

export const OBSERVATION_VALIDITY = [
  "valid",
  "stale",
  "invalid",
  "missing",
] as const;

export type ObservationValidity = (typeof OBSERVATION_VALIDITY)[number];

/** Age after which a read-only reference reading must not be treated as fresh. */
export const DEFAULT_FRESHNESS_MS = 10_000;

const UNIT_PATTERN = /^[A-Za-z%][A-Za-z0-9.%/_-]{0,31}$/;

export interface ObservationSource {
  readonly deviceId: string;
  readonly operation: string;
}

export interface Observation {
  readonly source: ObservationSource;
  readonly timestampMs: number;
  readonly freshnessMs: number;
  readonly validity: ObservationValidity;
  readonly value: boolean | number | null;
  readonly unit?: string;
}

export function assessObservation(
  input: Omit<Observation, "validity"> & { readonly invalid?: boolean },
  nowMs: number,
): Observation {
  const errors = validateObservationFields(
    { ...input, validity: "valid" },
    "now",
  );
  if (
    errors.length > 0 ||
    !Number.isInteger(nowMs) ||
    nowMs < input.timestampMs
  ) {
    return {
      source: input.source,
      timestampMs: Number.isFinite(input.timestampMs) ? input.timestampMs : 0,
      freshnessMs:
        input.freshnessMs > 0 ? input.freshnessMs : DEFAULT_FRESHNESS_MS,
      validity: "invalid",
      value: null,
      ...(input.unit ? { unit: input.unit } : {}),
    };
  }
  if (input.invalid || input.value === null) {
    return {
      ...stripInvalid(input),
      validity: input.value === null ? "missing" : "invalid",
    };
  }
  const age = nowMs - input.timestampMs;
  const validity: ObservationValidity =
    age >= input.freshnessMs ? "stale" : "valid";
  return { ...stripInvalid(input), validity };
}

function stripInvalid(
  input: Omit<Observation, "validity"> & { readonly invalid?: boolean },
): Omit<Observation, "validity"> {
  return {
    source: input.source,
    timestampMs: input.timestampMs,
    freshnessMs: input.freshnessMs,
    value: input.value,
    ...(input.unit ? { unit: input.unit } : {}),
  };
}

/** Check a stored observation. This does not read a device. */
export function parseObservation(input: unknown): ParseResult<Observation> {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  const errors = [
    ...unknownFieldErrors(
      input,
      ["source", "timestampMs", "freshnessMs", "validity", "value", "unit"],
      "",
    ),
    ...validateObservationFields(input, "stored"),
  ];
  if (errors.length > 0) return { ok: false, errors };
  const source = input.source as ObservationSource;
  const observation: Observation = {
    source: { deviceId: source.deviceId, operation: source.operation },
    timestampMs: input.timestampMs as number,
    freshnessMs: input.freshnessMs as number,
    validity: input.validity as ObservationValidity,
    value: input.value as boolean | number | null,
    ...(typeof input.unit === "string" ? { unit: input.unit } : {}),
  };
  return { ok: true, value: observation };
}

function validateObservationFields(
  input: Record<string, unknown>,
  mode: "now" | "stored",
): FieldError[] {
  const errors: FieldError[] = [];
  if (!isRecord(input.source)) {
    errors.push({ path: "source", message: "must be an object" });
  } else {
    errors.push(
      ...unknownFieldErrors(input.source, ["deviceId", "operation"], "source"),
    );
    const deviceId = checkName(input.source.deviceId, "source.deviceId");
    const operation = checkName(input.source.operation, "source.operation");
    if (deviceId) errors.push(deviceId);
    if (operation) errors.push(operation);
  }
  if (!isWholeMs(input.timestampMs)) {
    errors.push({
      path: "timestampMs",
      message: "must be an integer number of milliseconds from 0",
    });
  }
  if (!isFreshness(input.freshnessMs)) {
    errors.push({
      path: "freshnessMs",
      message: "must be an integer number of milliseconds from 1 to 86400000",
    });
  }
  if (
    input.unit !== undefined &&
    (typeof input.unit !== "string" || !UNIT_PATTERN.test(input.unit))
  ) {
    errors.push({
      path: "unit",
      message: "must be a unit such as degC or hPa",
    });
  }
  if (!isObservationValue(input.value)) {
    errors.push({
      path: "value",
      message: "must be a boolean, a finite number, or null",
    });
  }
  if (mode === "stored") {
    if (
      typeof input.validity !== "string" ||
      !(OBSERVATION_VALIDITY as readonly string[]).includes(input.validity)
    ) {
      errors.push({
        path: "validity",
        message: 'must be one of "valid", "stale", "invalid", "missing"',
      });
    } else if (input.validity === "valid" && input.value === null) {
      errors.push({
        path: "value",
        message: "cannot be null when validity is valid",
      });
    } else if (input.validity === "missing" && input.value !== null) {
      errors.push({
        path: "value",
        message: "must be null when validity is missing",
      });
    }
  }
  return errors;
}

function isObservationValue(value: unknown): value is boolean | number | null {
  return (
    typeof value === "boolean" ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isWholeMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000
  );
}

function isFreshness(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 86_400_000
  );
}
