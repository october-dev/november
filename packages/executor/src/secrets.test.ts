import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkEndpoint,
  createSecretStore,
  parseSecretRef,
  redactSecrets,
  type SecretRecord,
} from "./secrets.js";

const hardware: SecretRecord = {
  ref: { kind: "env", name: "BROKER_PASSWORD" },
  purpose: "hardware",
  projectId: "bench",
  deviceId: "host-led",
};

describe("credentials", () => {
  it("accepts only env and file references, never a pasted secret", () => {
    expect(parseSecretRef("env:BROKER_PASSWORD").ok).toBe(true);
    expect(parseSecretRef("file:/etc/november/broker-password").ok).toBe(true);
    const pasted = parseSecretRef("synthetic-broker-secret");
    expect(pasted.ok).toBe(false);
    if (!pasted.ok)
      expect(pasted.detail).not.toContain("synthetic-broker-secret");
  });

  it("keeps hardware secrets from the model and from another device", () => {
    const store = createSecretStore([hardware], {
      env: { BROKER_PASSWORD: "synthetic-broker-secret" },
    });
    const model = store.get({
      ref: hardware.ref,
      purpose: "model",
      projectId: "bench",
      deviceId: "host-led",
    });
    expect(model.ok).toBe(false);
    if (!model.ok)
      expect(model.detail).not.toContain("synthetic-broker-secret");
    const other = store.get({
      ref: hardware.ref,
      purpose: "hardware",
      projectId: "bench",
      deviceId: "other-led",
    });
    expect(other.ok).toBe(false);
    const allowed = store.get({
      ref: hardware.ref,
      purpose: "hardware",
      projectId: "bench",
      deviceId: "host-led",
    });
    expect(allowed).toEqual({ ok: true, value: "synthetic-broker-secret" });
  });

  it("redacts secrets, refuses a loose file, and rotates without widening access", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "november-secret-"));
    const file = path.join(directory, "broker");
    writeFileSync(file, "synthetic-file-secret\n", { mode: 0o644 });
    const ref = { kind: "file" as const, path: file };
    const store = createSecretStore([
      { ref, purpose: "hardware", projectId: "bench", deviceId: "host-led" },
    ]);
    const loose = store.get({
      ref,
      purpose: "hardware",
      projectId: "bench",
      deviceId: "host-led",
    });
    expect(loose.ok).toBe(false);
    if (!loose.ok) expect(loose.detail).not.toContain("synthetic-file-secret");

    chmodSync(file, 0o600);
    const opened = store.get({
      ref,
      purpose: "hardware",
      projectId: "bench",
      deviceId: "host-led",
    });
    expect(opened).toEqual({ ok: true, value: "synthetic-file-secret" });

    store.replace(ref, "synthetic-rotated-secret");
    expect(
      store.get({
        ref,
        purpose: "model",
        projectId: "bench",
        deviceId: "host-led",
      }).ok,
    ).toBe(false);
    expect(
      store.get({
        ref,
        purpose: "hardware",
        projectId: "bench",
        deviceId: "host-led",
      }),
    ).toEqual({ ok: true, value: "synthetic-rotated-secret" });
    store.revoke(ref);
    const revoked = store.get({
      ref,
      purpose: "hardware",
      projectId: "bench",
      deviceId: "host-led",
    });
    expect(revoked).toEqual({
      ok: false,
      detail: "credential has been revoked",
    });
    expect(
      redactSecrets(`failed ${"synthetic-rotated-secret"}`, [
        "synthetic-rotated-secret",
      ]),
    ).toBe("failed [redacted]");
  });

  it("refuses an unconfigured or untrusted destination before sending device data", () => {
    expect(
      checkEndpoint("https://models.example.com", {
        purpose: "model",
        explicit: false,
        certificateValid: true,
      }).ok,
    ).toBe(false);
    expect(
      checkEndpoint("http://models.example.com", {
        purpose: "model",
        explicit: true,
        certificateValid: true,
      }).detail,
    ).toMatch(/https/);
    expect(
      checkEndpoint("https://models.example.com", {
        purpose: "model",
        explicit: true,
        certificateValid: false,
      }).detail,
    ).toMatch(/certificate/);
    expect(
      checkEndpoint("http://127.0.0.1:9", {
        purpose: "telemetry",
        explicit: true,
        certificateValid: true,
      }).ok,
    ).toBe(true);
  });

  it("reports a missing credential as a degraded state", () => {
    const store = createSecretStore([hardware], { env: {} });
    expect(
      store.get({
        ref: hardware.ref,
        purpose: "hardware",
        projectId: "bench",
        deviceId: "host-led",
      }),
    ).toEqual({ ok: false, detail: "credential is missing" });
  });
});
