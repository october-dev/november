/** One validation problem. `path` is empty when the value itself is the wrong shape. */
export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unknownFieldErrors(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): FieldError[] {
  const errors: FieldError[] = [];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push({
        path: path.length === 0 ? key : `${path}.${key}`,
        message: "is not a known field",
      });
    }
  }
  return errors;
}

/** Lowercase device and operation ids, matching the configuration schema's id rule. */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function checkName(
  value: unknown,
  path: string,
): FieldError | undefined {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    return {
      path,
      message:
        "must be lowercase letters, digits or dashes, starting with a letter",
    };
  }
  return undefined;
}
