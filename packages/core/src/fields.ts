/**
 * Shared contract-validation primitives.
 *
 * These schemas are the single implementation for the contract parsers
 * in this package: observations, actions, and identity binding. They
 * use the same dependency, identifier/unit rules, and error mapping as
 * the device configuration schema, so the two agree once that work
 * lands. All objects are strict: unknown fields are rejected, numbers
 * are checked finite, and every failure carries a field-specific path.
 */
import { z } from "zod";

/** One validation problem. `path` is empty when the value itself is the wrong shape. */
export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export type ContractParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

/** Lowercase device and operation ids, matching the configuration schema's id rule. */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export const ID_MESSAGE =
  "must be lowercase letters, digits or dashes, starting with a letter";

/** Units match the configuration schema: 1-16 non-whitespace characters. */
export const UNIT_PATTERN = /^\S{1,16}$/;

export const UNIT_MESSAGE = "must be a unit such as degC or hPa";

/** Every message says what is wrong; a missing field says so instead. */
export const says = (message: string) => ({
  error: (issue: { input: unknown }) =>
    issue.input === undefined ? "is required" : message,
});

export const Id = z
  .string(says(ID_MESSAGE))
  .regex(NAME_PATTERN, says(ID_MESSAGE));

export const Unit = z
  .string(says(UNIT_MESSAGE))
  .regex(UNIT_PATTERN, says(UNIT_MESSAGE));

export const integer = (min: number, max: number, message: string) =>
  z
    .number(says(message))
    .int(says(message))
    .min(min, says(message))
    .max(max, says(message));

export const finiteNumber = (message: string) =>
  z.number(says(message)).refine(Number.isFinite, { error: message });

function pathText(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, key) => {
    if (typeof key === "number") return `${text}[${key}]`;
    return text ? `${text}.${String(key)}` : String(key);
  }, "");
}

/** One error per problem; an unknown-key issue becomes one error per field. */
export function toFieldErrors(
  issues: readonly z.core.$ZodIssue[],
): FieldError[] {
  return issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => ({
          path: pathText([...issue.path, key]),
          message: "is not a known field",
        }))
      : [{ path: pathText(issue.path), message: issue.message }],
  );
}

export function parseWith<T>(
  schema: z.ZodType<T>,
  input: unknown,
): ContractParseResult<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: toFieldErrors(parsed.error.issues) };
}
