/**
 * Bind a configured device to the resource in front of the adapter.
 *
 * The identity key is the authority. A path such as `/dev/ttyACM0` or a GPIO
 * chip path may change when a cable is replugged. The same path with a
 * different key is a different device and must not keep the old permission.
 * Parsing and binding only compare strings. They do not open the resource.
 */
import { z } from "zod";
import { parseWith, says, type ContractParseResult } from "./fields.js";

export const TRANSPORT_KINDS = [
  "gpio",
  "i2c",
  "spi",
  "serial",
  "mqtt",
] as const;

export type TransportKind = (typeof TRANSPORT_KINDS)[number];

const KEY_PATTERN = /^[A-Za-z0-9:._+/-]{1,200}$/;

const ResourceIdentitySchema = z.strictObject({
  kind: z.enum(
    TRANSPORT_KINDS,
    says('must be one of "gpio", "i2c", "spi", "serial", "mqtt"'),
  ),
  key: z
    .string(says("must be a stable identity token without spaces"))
    .regex(KEY_PATTERN, says("must be a stable identity token without spaces")),
  path: z
    .string(says("must be a device path without parent-directory segments"))
    .min(1, says("must be a device path without parent-directory segments"))
    .max(256, says("must be a device path without parent-directory segments"))
    .refine(
      (path) => !path.includes("\0") && !path.split(/[\\/]/).includes(".."),
      { error: "must be a device path without parent-directory segments" },
    )
    .optional(),
});

export type ResourceIdentity = z.output<typeof ResourceIdentitySchema>;

export function parseResourceIdentity(
  input: unknown,
): ContractParseResult<ResourceIdentity> {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  return parseWith(ResourceIdentitySchema, input);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
