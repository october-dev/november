/**
 * Bind a configured device to the resource in front of the adapter.
 *
 * The identity key is the authority. A path such as `/dev/ttyACM0` or a GPIO
 * chip path may change when a cable is replugged. The same path with a
 * different key is a different device and must not keep the old permission.
 * Parsing and binding only compare strings. They do not open the resource.
 */
import {
  isRecord,
  unknownFieldErrors,
  type FieldError,
  type ParseResult,
} from "./fields.js";

export const TRANSPORT_KINDS = [
  "gpio",
  "i2c",
  "spi",
  "serial",
  "mqtt",
] as const;

export type TransportKind = (typeof TRANSPORT_KINDS)[number];

const KEY_PATTERN = /^[A-Za-z0-9:._+/-]{1,200}$/;

export interface ResourceIdentity {
  readonly kind: TransportKind;
  /** Stable name for this resource. Not a volatile device path. */
  readonly key: string;
  /** Current location, if one is known. Rebinding may replace it. */
  readonly path?: string;
}

export function parseResourceIdentity(
  input: unknown,
): ParseResult<ResourceIdentity> {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  const errors: FieldError[] = unknownFieldErrors(
    input,
    ["kind", "key", "path"],
    "",
  );
  if (
    typeof input.kind !== "string" ||
    !(TRANSPORT_KINDS as readonly string[]).includes(input.kind)
  ) {
    errors.push({
      path: "kind",
      message: 'must be one of "gpio", "i2c", "spi", "serial", "mqtt"',
    });
  }
  if (typeof input.key !== "string" || !KEY_PATTERN.test(input.key)) {
    errors.push({
      path: "key",
      message: "must be a stable identity token without spaces",
    });
  }
  if (input.path !== undefined && !isSafePath(input.path)) {
    errors.push({
      path: "path",
      message: "must be a device path without parent-directory segments",
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind: input.kind as TransportKind,
      key: input.key as string,
      ...(typeof input.path === "string" ? { path: input.path } : {}),
    },
  };
}

export type BindResult =
  | { readonly ok: true; readonly identity: ResourceIdentity }
  | { readonly ok: false; readonly reason: string };

/**
 * Accept `observed` only when it is the same resource as `configured`.
 * A new path is kept. A new key is rejected even when the path is unchanged.
 */
export function bindResource(
  configured: ResourceIdentity,
  observed: ResourceIdentity,
): BindResult {
  if (configured.kind !== observed.kind) {
    return { ok: false, reason: "transport kind does not match" };
  }
  if (configured.key !== observed.key) {
    return {
      ok: false,
      reason:
        "identity key does not match; the resource at this path is a different device",
    };
  }
  return {
    ok: true,
    identity: {
      kind: observed.kind,
      key: observed.key,
      ...(observed.path !== undefined
        ? { path: observed.path }
        : configured.path !== undefined
          ? { path: configured.path }
          : {}),
    },
  };
}

function isSafePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    return false;
  if (value.includes("\0")) return false;
  return !value.split(/[\\/]/).includes("..");
}
