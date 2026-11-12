/**
 * Credential references for the execution service (issue #9).
 *
 * Values are loaded from an env name or a mode-0600 file. They are not
 * accepted as literals, not returned to the model purpose when they belong
 * to hardware, and not copied into errors. Replacing a value keeps the same
 * purpose and the same project/device scope.
 */
import { readFileSync, statSync } from "node:fs";

export type SecretPurpose = "model" | "hardware";

export type SecretRef =
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "file"; readonly path: string };

export interface SecretRecord {
  readonly ref: SecretRef;
  readonly purpose: SecretPurpose;
  readonly projectId: string;
  readonly deviceId: string;
}

export type SecretResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly detail: string };

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SCOPE = /^[a-z][a-z0-9-]{0,63}$/;

export function parseSecretRef(
  input: string,
): { ok: true; ref: SecretRef } | { ok: false; detail: string } {
  if (input.startsWith("env:")) {
    const name = input.slice(4);
    if (!ENV_NAME.test(name))
      return { ok: false, detail: "environment secret name is invalid" };
    return { ok: true, ref: { kind: "env", name } };
  }
  if (input.startsWith("file:")) {
    const path = input.slice(5);
    if (!path.startsWith("/") || path.split("/").includes("..")) {
      return { ok: false, detail: "credential file must be an absolute path" };
    }
    return { ok: true, ref: { kind: "file", path } };
  }
  return { ok: false, detail: "credential must be an env: or file: reference" };
}

export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

export interface SecretStore {
  get(input: {
    readonly ref: SecretRef;
    readonly purpose: SecretPurpose;
    readonly projectId: string;
    readonly deviceId: string;
  }): SecretResult;
  revoke(ref: SecretRef): void;
  /** Point the same reference at a new value without changing who may use it. */
  replace(ref: SecretRef, value: string): void;
}

export function createSecretStore(
  records: readonly SecretRecord[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly readFile?: (path: string) => string;
  } = {},
): SecretStore {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? readRestrictedFile;
  const revoked = new Set<string>();
  const replacements = new Map<string, string>();
  const known = records.map((record) => ({ ...record }));

  return {
    get(input) {
      if (!SCOPE.test(input.projectId) || !SCOPE.test(input.deviceId)) {
        return { ok: false, detail: "credential scope is invalid" };
      }
      const record = known.find((item) => sameRef(item.ref, input.ref));
      if (!record) return { ok: false, detail: "credential is not configured" };
      if (record.purpose !== input.purpose) {
        return { ok: false, detail: "credential purpose does not match" };
      }
      if (
        record.projectId !== input.projectId ||
        record.deviceId !== input.deviceId
      ) {
        return {
          ok: false,
          detail: "credential is not available to this project or device",
        };
      }
      if (revoked.has(refKey(input.ref)))
        return { ok: false, detail: "credential has been revoked" };
      const replaced = replacements.get(refKey(input.ref));
      if (replaced !== undefined) return { ok: true, value: replaced };
      try {
        if (input.ref.kind === "env") {
          const value = env[input.ref.name];
          if (!value) return { ok: false, detail: "credential is missing" };
          return { ok: true, value };
        }
        return { ok: true, value: readFile(input.ref.path) };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "credential could not be read";
        return {
          ok: false,
          detail: redactSecrets(message, [...replacements.values()]),
        };
      }
    },
    revoke(ref) {
      revoked.add(refKey(ref));
    },
    replace(ref, value) {
      if (value.length === 0)
        throw new Error("replacement credential is empty");
      replacements.set(refKey(ref), value);
      revoked.delete(refKey(ref));
    },
  };
}

function readRestrictedFile(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("credential file is missing");
  if ((stat.mode & 0o077) !== 0)
    throw new Error("credential file permissions are too open");
  return readFileSync(path, "utf8").replace(/\n$/, "");
}

function sameRef(left: SecretRef, right: SecretRef): boolean {
  return refKey(left) === refKey(right);
}

function refKey(ref: SecretRef): string {
  return ref.kind === "env" ? `env:${ref.name}` : `file:${ref.path}`;
}

/**
 * A hosted destination must be explicit and https, except a loopback test
 * server. A failed certificate check refuses the connection before any
 * device data is sent.
 */
export function checkEndpoint(
  baseUrl: string,
  options: {
    readonly purpose: "model" | "telemetry";
    readonly explicit: boolean;
    readonly certificateValid: boolean;
  },
):
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly detail: string } {
  if (!options.explicit)
    return { ok: false, detail: "destination was not explicitly configured" };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, detail: "destination is not a URL" };
  }
  if (url.username || url.password)
    return { ok: false, detail: "destination must not embed credentials" };
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { ok: false, detail: "destination must use https" };
  }
  if (!options.certificateValid && url.protocol === "https:") {
    return { ok: false, detail: "destination certificate is invalid" };
  }
  if (options.purpose === "telemetry" && !options.explicit) {
    return { ok: false, detail: "destination was not explicitly configured" };
  }
  return { ok: true, url: url.toString() };
}
