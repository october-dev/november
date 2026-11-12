import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkEndpoint,
  createSecretStore,
  parseSecretRef,
  redactSecrets,
  type SecretRecord,
  type SecretRef,
  type SecretResult,
  type SecretStore,
} from "./secrets.js";

const hardware: SecretRecord = {
  ref: { kind: "env", name: "BROKER_PASSWORD" },
  purpose: "hardware",
  projectId: "bench",
  deviceId: "host-led",
};

type AnyResult =
  | SecretResult
  | { readonly ok: true; readonly ref: SecretRef }
  | { readonly ok: true; readonly url: string };

function valued(result: SecretResult): string {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected a value: ${result.detail}`);
  return result.value;
}

function failed(result: AnyResult): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failure");
  return result.detail;
}

function hardwareGet(store: SecretStore): SecretResult {
  return store.get({
    ref: hardware.ref,
    purpose: "hardware",
    projectId: "bench",
    deviceId: "host-led",
  });
}

function withSecretFile(
  contents: string,
  mode: number,
  run: (file: string, directory: string) => void,
): void {
  const directory = mkdtempSync(path.join(tmpdir(), "november-secret-"));
  try {
    const file = path.join(directory, "broker");
    writeFileSync(file, contents);
    chmodSync(file, mode);
    run(file, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function fileRecord(file: string): SecretRecord {
  return {
    ref: { kind: "file", path: file },
    purpose: "hardware",
    projectId: "bench",
    deviceId: "host-led",
  };
}

describe("credentials", () => {
  it("accepts only env and file references, never a pasted secret", () => {
    expect(parseSecretRef("env:BROKER_PASSWORD").ok).toBe(true);
    expect(parseSecretRef("file:/etc/november/broker-password").ok).toBe(true);
    const pasted = parseSecretRef("synthetic-broker-secret");
    expect(failed(pasted)).not.toContain("synthetic-broker-secret");
    expect(failed(parseSecretRef("env:lowercase"))).toContain("invalid");
    expect(failed(parseSecretRef("env:"))).toContain("invalid");
    expect(failed(parseSecretRef("file:relative/path"))).toBe(
      "credential file must be an absolute path",
    );
    expect(failed(parseSecretRef("file:/data/../secret"))).toBe(
      "credential file path must not contain ..",
    );
    expect(failed(parseSecretRef("file:/data/\0secret"))).toBe(
      "credential file path is invalid",
    );
  });

  it("keeps hardware secrets from the model, another project, and another device", () => {
    const store = createSecretStore([hardware], {
      env: { BROKER_PASSWORD: "synthetic-broker-secret" },
    });
    const model = failed(
      store.get({
        ref: hardware.ref,
        purpose: "model",
        projectId: "bench",
        deviceId: "host-led",
      }),
    );
    expect(model).not.toContain("synthetic-broker-secret");
    expect(
      failed(
        store.get({
          ref: hardware.ref,
          purpose: "hardware",
          projectId: "other",
          deviceId: "host-led",
        }),
      ),
    ).toContain("not available");
    expect(
      failed(
        store.get({
          ref: hardware.ref,
          purpose: "hardware",
          projectId: "bench",
          deviceId: "other-led",
        }),
      ),
    ).toContain("not available");
    expect(valued(hardwareGet(store))).toBe("synthetic-broker-secret");
  });

  it("rejects duplicate and invalid records when constructing the store", () => {
    const other: SecretRecord = {
      ref: { kind: "env", name: "BROKER_PASSWORD" },
      purpose: "hardware",
      projectId: "bench",
      deviceId: "other-led",
    };
    expect(() => createSecretStore([hardware, other])).toThrow(
      "credential reference is configured twice",
    );
    expect(() =>
      createSecretStore([{ ...hardware, projectId: "Bench" }]),
    ).toThrow("credential scope is invalid");
    expect(() =>
      createSecretStore([
        {
          ref: { kind: "file", path: "relative/path" },
          purpose: "hardware",
          projectId: "bench",
          deviceId: "host-led",
        },
      ]),
    ).toThrow("credential file must be an absolute path");
  });

  it("ignores later mutations of the caller's records, references, and env", () => {
    const ref = { kind: "env" as const, name: "KEY_A" };
    const records: SecretRecord[] = [
      { ref, purpose: "hardware", projectId: "bench", deviceId: "host-led" },
    ];
    const env = { KEY_A: "a-secret", KEY_B: "b-secret" };
    const store = createSecretStore(records, { env });
    ref.name = "KEY_B";
    records.push({
      ref: { kind: "env", name: "KEY_B" },
      purpose: "hardware",
      projectId: "bench",
      deviceId: "host-led",
    });
    env.KEY_A = "mutated-secret";
    expect(
      failed(
        store.get({
          ref: { kind: "env", name: "KEY_B" },
          purpose: "hardware",
          projectId: "bench",
          deviceId: "host-led",
        }),
      ),
    ).toBe("credential is not configured");
    expect(
      valued(
        store.get({
          ref: { kind: "env", name: "KEY_A" },
          purpose: "hardware",
          projectId: "bench",
          deviceId: "host-led",
        }),
      ),
    ).toBe("a-secret");
  });

  it("refuses a loose file and reads a restricted one without leaking it", () => {
    for (const mode of [0o644, 0o640]) {
      withSecretFile("synthetic-file-secret\n", mode, (file) => {
        const store = createSecretStore([fileRecord(file)]);
        const detail = failed(
          store.get({
            ref: { kind: "file", path: file },
            purpose: "hardware",
            projectId: "bench",
            deviceId: "host-led",
          }),
        );
        expect(detail).toBe("credential file permissions are too open");
        expect(detail).not.toContain("synthetic-file-secret");
      });
    }
    withSecretFile("synthetic-file-secret\n", 0o600, (file) => {
      const store = createSecretStore([fileRecord(file)]);
      expect(
        valued(
          store.get({
            ref: { kind: "file", path: file },
            purpose: "hardware",
            projectId: "bench",
            deviceId: "host-led",
          }),
        ),
      ).toBe("synthetic-file-secret");
    });
  });

  it("treats empty files as missing and strips one trailing line ending", () => {
    withSecretFile("", 0o600, (file) => {
      const store = createSecretStore([fileRecord(file)]);
      expect(
        failed(
          store.get({
            ref: { kind: "file", path: file },
            purpose: "hardware",
            projectId: "bench",
            deviceId: "host-led",
          }),
        ),
      ).toBe("credential is missing");
    });
    withSecretFile("\n", 0o600, (file) => {
      const store = createSecretStore([fileRecord(file)]);
      expect(
        failed(
          store.get({
            ref: { kind: "file", path: file },
            purpose: "hardware",
            projectId: "bench",
            deviceId: "host-led",
          }),
        ),
      ).toBe("credential is missing");
    });
    withSecretFile("crlf-secret\r\n", 0o600, (file) => {
      const store = createSecretStore([fileRecord(file)]);
      expect(
        valued(
          store.get({
            ref: { kind: "file", path: file },
            purpose: "hardware",
            projectId: "bench",
            deviceId: "host-led",
          }),
        ),
      ).toBe("crlf-secret");
    });
    withSecretFile("kept-newline\n\n", 0o600, (file) => {
      const store = createSecretStore([fileRecord(file)]);
      expect(
        valued(
          store.get({
            ref: { kind: "file", path: file },
            purpose: "hardware",
            projectId: "bench",
            deviceId: "host-led",
          }),
        ),
      ).toBe("kept-newline\n");
    });
  });

  it("reports missing, non-regular, and unreadable files distinctly", () => {
    withSecretFile("synthetic-file-secret\n", 0o600, (_file, directory) => {
      const absent = path.join(directory, "absent");
      const store = createSecretStore([
        fileRecord(absent),
        {
          ref: { kind: "file", path: directory },
          purpose: "hardware",
          projectId: "bench",
          deviceId: "host-led",
        },
      ]);
      expect(
        failed(
          store.get({
            ref: { kind: "file", path: absent },
            purpose: "hardware",
            projectId: "bench",
            deviceId: "host-led",
          }),
        ),
      ).toBe("credential is missing");
      expect(
        failed(
          store.get({
            ref: { kind: "file", path: directory },
            purpose: "hardware",
            projectId: "bench",
            deviceId: "host-led",
          }),
        ),
      ).toBe("credential file is not a regular file");
    });
    withSecretFile("synthetic-file-secret\n", 0o000, (file) => {
      const store = createSecretStore([fileRecord(file)]);
      expect(
        failed(
          store.get({
            ref: { kind: "file", path: file },
            purpose: "hardware",
            projectId: "bench",
            deviceId: "host-led",
          }),
        ),
      ).toBe("credential file permission denied");
      chmodSync(file, 0o600);
    });
  });

  it("rotates and revokes through the source file across store reconstruction", () => {
    withSecretFile("first-secret\n", 0o600, (file) => {
      const open = () => createSecretStore([fileRecord(file)]);
      const read = () =>
        open().get({
          ref: { kind: "file", path: file },
          purpose: "hardware",
          projectId: "bench",
          deviceId: "host-led",
        });
      expect(valued(read())).toBe("first-secret");
      writeFileSync(file, "second-secret\n");
      chmodSync(file, 0o600);
      expect(valued(read())).toBe("second-secret");
      rmSync(file);
      expect(failed(read())).toBe("credential is missing");
    });
  });

  it("redacts short and overlapping secrets regardless of order", () => {
    expect(redactSecrets("pw=abc", ["abc"])).toBe("pw=[redacted]");
    expect(redactSecrets("pw=abcdefgh", ["abcd", "abcdefgh"])).toBe(
      "pw=[redacted]",
    );
    expect(redactSecrets("pw=abcdefgh", ["abcdefgh", "abcd"])).toBe(
      "pw=[redacted]",
    );
    expect(redactSecrets("abcdef", ["abcd", "cdef"])).toBe("[redacted]");
    expect(redactSecrets("abcd", ["ab", "cd"])).toBe("[redacted]");
    expect(redactSecrets("nothing here", ["absent"])).toBe("nothing here");
    expect(redactSecrets("x", ["", "x"])).toBe("[redacted]");
  });

  it("refuses an unconfigured or untrusted destination before sending device data", () => {
    expect(
      failed(
        checkEndpoint("https://models.example.com", {
          explicit: false,
          certificateValid: true,
        }),
      ),
    ).toContain("explicitly");
    expect(
      failed(
        checkEndpoint("http://models.example.com", {
          explicit: true,
          certificateValid: true,
        }),
      ),
    ).toMatch(/https/);
    expect(
      failed(
        checkEndpoint("https://models.example.com", {
          explicit: true,
          certificateValid: false,
        }),
      ),
    ).toMatch(/certificate/);
    expect(
      failed(
        checkEndpoint("https://user:pass@models.example.com", {
          explicit: true,
          certificateValid: true,
        }),
      ),
    ).toContain("credentials");
    expect(
      failed(
        checkEndpoint("mqtts://broker.example.com:8883", {
          explicit: true,
          certificateValid: true,
        }),
      ),
    ).toMatch(/https/);
    expect(
      failed(
        checkEndpoint("not a url", {
          explicit: true,
          certificateValid: true,
        }),
      ),
    ).toContain("URL");
    for (const loopback of [
      "http://127.0.0.1:9",
      "http://localhost:9",
      "http://[::1]:9",
    ]) {
      const allowed = checkEndpoint(loopback, {
        explicit: true,
        certificateValid: true,
      });
      expect(allowed.ok).toBe(true);
    }
    expect(
      checkEndpoint("https://models.example.com", {
        explicit: true,
        certificateValid: true,
      }).ok,
    ).toBe(true);
  });

  it("reports a missing credential as a degraded state", () => {
    const store = createSecretStore([hardware], { env: {} });
    expect(hardwareGet(store)).toEqual({
      ok: false,
      detail: "credential is missing",
    });
  });
});
