/**
 * Credential references for the execution service (issue #9).
 *
 * Values are loaded from an env name or a mode-0600 file. They are not
 * accepted as literals, not returned to the wrong purpose, and not copied
 * into errors. An empty value after line-ending normalization counts as
 * missing, matching the environment behavior.
 *
 * The configured source is the authority for the credential lifecycle:
 * rotate by securely replacing the file, revoke locally by removing it.
 * Both take effect on the next read and survive store reconstruction.
 * Changes to external environment configuration require restarting with
 * the new environment. Removing a local credential does not revoke a
 * previously issued provider/broker credential.
 *
 * Purpose, project, and device checks are consistency guards, not caller
 * authentication: this helper does not verify processes or local clients.
 * Real isolation (separate OS access per process, authenticated callers)
 * and destination enforcement remain integration work, as does TLS
 * verification against the actual connection.
 */
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";

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

function checkRef(ref: SecretRef): string | undefined {
  if (ref.kind === "env") {
    if (!ENV_NAME.test(ref.name)) return "environment secret name is invalid";
    return undefined;
  }
  if (ref.path.includes("\0")) return "credential file path is invalid";
  if (!ref.path.startsWith("/")) {
    return "credential file must be an absolute path";
  }
  if (ref.path.split("/").includes("..")) {
    return "credential file path must not contain ..";
  }
  return undefined;
}

export function parseSecretRef(
  input: string,
): { ok: true; ref: SecretRef } | { ok: false; detail: string } {
  if (input.startsWith("env:")) {
    const ref: SecretRef = { kind: "env", name: input.slice(4) };
    const invalid = checkRef(ref);
    if (invalid) return { ok: false, detail: invalid };
    return { ok: true, ref };
  }
  if (input.startsWith("file:")) {
    const ref: SecretRef = { kind: "file", path: input.slice(5) };
    const invalid = checkRef(ref);
    if (invalid) return { ok: false, detail: invalid };
    return { ok: true, ref };
  }
  return { ok: false, detail: "credential must be an env: or file: reference" };
}

/**
 * Redact every nonempty secret occurrence in the original text, whatever
 * their lengths, overlaps, or list order. Contiguous covered spans merge
 * into one marker.
 */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  const covered = new Array<boolean>(text.length).fill(false);
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    let from = 0;
    for (;;) {
      const found = text.indexOf(secret, from);
      if (found === -1) break;
      for (let i = found; i < found + secret.length; i += 1) covered[i] = true;
      from = found + 1;
    }
  }
  let redacted = "";
  let i = 0;
  while (i < text.length) {
    if (!covered[i]) {
      redacted += text[i];
      i += 1;
      continue;
    }
    redacted += "[redacted]";
    while (i < text.length && covered[i]) i += 1;
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
}

export function createSecretStore(
  records: readonly SecretRecord[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): SecretStore {
  const env = { ...(options.env ?? process.env) };
  // Snapshot each record including its nested reference, so later caller
  // mutations cannot widen the grant. Reject ambiguous or invalid
  // configuration up front instead of failing closed per read.
  const seenRefs = new Set<string>();
  const known = records.map((record) => {
    if (!SCOPE.test(record.projectId) || !SCOPE.test(record.deviceId)) {
      throw new Error("credential scope is invalid");
    }
    const invalid = checkRef(record.ref);
    if (invalid) throw new Error(invalid);
    const key = refKey(record.ref);
    if (seenRefs.has(key)) {
      throw new Error("credential reference is configured twice");
    }
    seenRefs.add(key);
    return {
      ref: { ...record.ref },
      purpose: record.purpose,
      projectId: record.projectId,
      deviceId: record.deviceId,
    };
  });

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
      try {
        if (input.ref.kind === "env") {
          const value = env[input.ref.name];
          if (!value) return { ok: false, detail: "credential is missing" };
          return { ok: true, value };
        }
        return { ok: true, value: readRestrictedFile(input.ref.path) };
      } catch (error) {
        return { ok: false, detail: fileFailureDetail(error) };
      }
    },
  };
}

function fileFailureDetail(error: unknown): string {
  if (error instanceof RestrictedFileError) return error.detail;
  if (isErrno(error, "ENOENT")) return "credential is missing";
  if (isErrno(error, "EACCES") || isErrno(error, "EPERM")) {
    return "credential file permission denied";
  }
  return "credential file cannot be read";
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

class RestrictedFileError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.detail = detail;
  }
}

function readRestrictedFile(path: string): string {
  // Reject obviously unsuitable paths before opening, so a FIFO can never
  // block the open. The opened descriptor is re-verified below.
  const pre = statSync(path);
  if (!pre.isFile()) {
    throw new RestrictedFileError("credential file is not a regular file");
  }
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== pre.ino || stat.dev !== pre.dev) {
      throw new RestrictedFileError("credential file is not a regular file");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new RestrictedFileError("credential file permissions are too open");
    }
    const contents = readFileSync(fd, "utf8");
    // Strip exactly one trailing line ending (LF or CRLF); anything else,
    // including further newlines, is part of the secret.
    const value = contents.endsWith("\n")
      ? contents.slice(0, contents.endsWith("\r\n") ? -2 : -1)
      : contents;
    if (value.length === 0) {
      throw new RestrictedFileError("credential is missing");
    }
    return value;
  } finally {
    closeSync(fd);
  }
}

function sameRef(left: SecretRef, right: SecretRef): boolean {
  return refKey(left) === refKey(right);
}

function refKey(ref: SecretRef): string {
  return ref.kind === "env" ? `env:${ref.name}` : `file:${ref.path}`;
}

/**
 * HTTP(S) destination policy check on trusted caller inputs: the URL must
 * be explicit and credential-free, plaintext HTTP is allowed only for
 * loopback, and the caller reports the certificate result. This validates
 * policy, not a live connection; MQTT destinations and real TLS
 * verification belong with the connecting code.
 */
export function checkEndpoint(
  baseUrl: string,
  options: {
    readonly explicit: boolean;
    readonly certificateValid: boolean;
  },
):
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly detail: string } {
  if (!options.explicit) {
    return { ok: false, detail: "destination was not explicitly configured" };
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, detail: "destination is not a URL" };
  }
  if (url.username || url.password) {
    return { ok: false, detail: "destination must not embed credentials" };
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { ok: false, detail: "destination must use https" };
  }
  if (!options.certificateValid && url.protocol === "https:") {
    return { ok: false, detail: "destination certificate is invalid" };
  }
  return { ok: true, url: url.toString() };
}
