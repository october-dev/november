/**
 * A reading from one device operation.
 *
 * Freshness is a limit on age, not a promise that the sensor is still
 * connected. Callers pass `nowMs` from their own clock. Read-only reference
 * devices are stale 10 seconds after the last valid sample
 * (docs/support-matrix.md, safe states).
 *
 * Structural parsing and age assessment are separate steps. Parse a
 * stored or incoming record with parseObservation; re-evaluate a parsed
 * sample's age with assessObservation. Reassessment never promotes an
 * invalid or missing sample to valid, and every assessed observation
 * parses again.
 *
 * Byte transfer results enter the model as `{ type: "bytes", base64 }`
 * values, so reference SPI loopback results can ride the same reading
 * shape and go stale like any other sample.
 */
import { z } from "zod";
import {
  Id,
  Unit,
  finiteNumber,
  integer,
  parseWith,
  says,
  type ContractParseResult,
  type FieldError,
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

const TIMESTAMP_MESSAGE = "must be an integer number of milliseconds from 0";
const FRESHNESS_MESSAGE =
  "must be an integer number of milliseconds from 1 to 86400000";
const VALUE_MESSAGE = "must be a boolean, a finite number, bytes, or null";
const BYTES_MESSAGE = "must be base64-encoded bytes of at most 4096 bytes";

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** 4096 raw bytes encode to 5464 base64 characters. */
const MAX_BASE64_LENGTH = 5464;

const ObservationSourceSchema = z.strictObject({
  deviceId: Id,
  operation: Id,
});

const BytesValueSchema = z.strictObject({
  type: z.literal("bytes"),
  base64: z
    .string(says(BYTES_MESSAGE))
    .regex(BASE64_PATTERN, says(BYTES_MESSAGE))
    .max(MAX_BASE64_LENGTH, says(BYTES_MESSAGE)),
});

const ObservationValueSchema = z.union(
  [z.boolean(), finiteNumber(VALUE_MESSAGE), BytesValueSchema, z.null()],
  says(VALUE_MESSAGE),
);

const ObservationFieldsSchema = z.strictObject({
  source: ObservationSourceSchema,
  timestampMs: integer(0, 8_640_000_000_000, TIMESTAMP_MESSAGE),
  freshnessMs: integer(1, 86_400_000, FRESHNESS_MESSAGE),
  value: ObservationValueSchema,
  unit: Unit.optional(),
});

const ObservationSchema = ObservationFieldsSchema.extend({
  validity: z.enum(
    OBSERVATION_VALIDITY,
    says('must be one of "valid", "stale", "invalid", "missing"'),
  ),
})
  .refine(
    (observation) =>
      observation.validity !== "valid" || observation.value !== null,
    { path: ["value"], error: "cannot be null when validity is valid" },
  )
  .refine(
    (observation) =>
      observation.validity !== "missing" || observation.value === null,
    { path: ["value"], error: "must be null when validity is missing" },
  );

export type ObservationSource = z.output<typeof ObservationSourceSchema>;
export type ObservationBytes = z.output<typeof BytesValueSchema>;
export type Observation = z.output<typeof ObservationSchema>;

/** Check a stored observation. This does not read a device. */
export function parseObservation(
  input: unknown,
): ContractParseResult<Observation> {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  return parseWith(ObservationSchema, input);
}

/**
 * Re-evaluate a sample's age at `nowMs`. Accepts a fresh sample (with an
 * optional `invalid` flag) or a stored observation (with `validity`, and
 * no `invalid` flag). Invalid and missing samples keep their status and
 * value; anything else is judged by age alone. Malformed input is
 * rejected with errors instead of a partially repaired record.
 */
export function assessObservation(
  input: unknown,
  nowMs: number,
): ContractParseResult<Observation> {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  const markerErrors = checkMarkers(input);
  if (markerErrors.length > 0) {
    return { ok: false, errors: markerErrors };
  }
  const fields = parseWith(ObservationFieldsSchema, stripMarkers(input));
  if (!fields.ok) return fields;
  if (typeof nowMs !== "number" || !Number.isInteger(nowMs)) {
    return {
      ok: false,
      errors: [{ path: "", message: "nowMs must be an integer" }],
    };
  }
  if (nowMs < fields.value.timestampMs) {
    return {
      ok: false,
      errors: [{ path: "", message: "nowMs predates the sample timestamp" }],
    };
  }
  const sample = fields.value;
  if (input.invalid === true || input.validity === "invalid") {
    return parseWith(ObservationSchema, { ...sample, validity: "invalid" });
  }
  if (sample.value === null) {
    return parseWith(ObservationSchema, { ...sample, validity: "missing" });
  }
  if (input.validity === "missing") {
    return {
      ok: false,
      errors: [
        { path: "value", message: "must be null when validity is missing" },
      ],
    };
  }
  const age = nowMs - sample.timestampMs;
  const validity: ObservationValidity =
    age >= sample.freshnessMs ? "stale" : "valid";
  return parseWith(ObservationSchema, { ...sample, validity });
}

function checkMarkers(input: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];
  const allowed = [
    "source",
    "timestampMs",
    "freshnessMs",
    "value",
    "unit",
    "validity",
    "invalid",
  ];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      errors.push({ path: key, message: "is not a known field" });
    }
  }
  if (input.validity !== undefined && input.invalid !== undefined) {
    errors.push({
      path: "",
      message: "validity and invalid must not both be present",
    });
  }
  if (
    input.validity !== undefined &&
    (typeof input.validity !== "string" ||
      !(OBSERVATION_VALIDITY as readonly string[]).includes(input.validity))
  ) {
    errors.push({
      path: "validity",
      message: 'must be one of "valid", "stale", "invalid", "missing"',
    });
  }
  if (input.invalid !== undefined && input.invalid !== true) {
    errors.push({
      path: "invalid",
      message: "must be true when present",
    });
  }
  return errors;
}

function stripMarkers(input: Record<string, unknown>): Record<string, unknown> {
  const { validity: _validity, invalid: _invalid, ...fields } = input;
  void _validity;
  void _invalid;
  return fields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
