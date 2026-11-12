/**
 * Internal enforcement component for device policy (issue #8).
 *
 * This library checks caller, device, operation, payload, duration,
 * state, rate, and single-use approval before running an effect, and it
 * reports the effect's evidence-based outcome. Time comes from one
 * injected monotonic clock; requests never carry their own timestamps.
 * State preconditions read trusted observations, never assumed values.
 *
 * OS process isolation and caller authentication are still to be
 * implemented: the caller id is request data, and arming, approval
 * issuance, and execution share this object, which trusted executor
 * code must hold. Unattended actuation is unsupported: actuations fail
 * immediately in unattended mode, while reads proceed.
 */
import { createHash, randomBytes } from "node:crypto";
import type { ActionOutcome } from "@november/core";
import {
  isRecord,
  parsePolicy,
  type PolicyDocument,
  type PolicyOperation,
} from "./policy.js";

export type ServiceMode = "development" | "unattended";

export interface ExecutionRequest {
  readonly callerId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly payload: boolean | number | null;
  readonly activeMs?: number;
  readonly approvalToken?: string;
}

export interface ExecutionResult {
  readonly outcome: ActionOutcome;
  readonly detail: string;
  readonly data?: unknown;
}

export interface EffectOutcome {
  readonly outcome: "confirmed" | "failed" | "unknown";
  readonly detail?: string;
}

export type ExecutionEffect = (
  request: ValidatedAction,
) => EffectOutcome | Promise<EffectOutcome>;

export interface ValidatedAction {
  readonly callerId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly payload: boolean | number | null;
  readonly activeMs?: number;
}

export interface DeviceObservation {
  /** Observed output values by operation name. */
  readonly outputs: Readonly<Record<string, boolean | number>>;
  /** Service-clock time of the observation. */
  readonly atMs: number;
  readonly valid: boolean;
}

export type DeviceObserver = (
  deviceId: string,
) => DeviceObservation | Promise<DeviceObservation>;

export type DeviceReader = (input: {
  readonly deviceId: string;
  readonly operation: string;
}) => unknown | Promise<unknown>;

export interface ApprovalGrant {
  readonly ok: true;
  readonly token: string;
  readonly expiresAtMs: number;
  readonly policyVersion: number;
}

export type ApprovalResult =
  ApprovalGrant | { readonly ok: false; readonly detail: string };

interface StoredApproval {
  readonly callerId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly payloadHash: string;
  readonly activeMs: number | undefined;
  readonly policyVersion: number;
  readonly expiresAtMs: number;
  used: boolean;
}

export interface ExecutionService {
  readonly policyVersion: number;
  readonly mode: ServiceMode;
  readonly armed: boolean;
  arm(): void;
  disarm(): void;
  issueApproval(input: {
    readonly callerId: string;
    readonly deviceId: string;
    readonly operation: string;
    readonly payload: boolean | number | null;
    readonly activeMs?: number;
    readonly ttlMs?: number;
  }): ApprovalResult;
  execute(request: unknown): Promise<ExecutionResult>;
}

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const MAX_OUTSTANDING_APPROVALS = 128;
const RATE_WINDOW_MS = 60_000;

export function createExecutionService(
  policyInput: unknown,
  options: {
    readonly mode?: ServiceMode;
    readonly clock?: () => number;
    readonly maxObservationAgeMs?: number;
    readonly effect?: ExecutionEffect;
    readonly observe?: DeviceObserver;
    readonly read?: DeviceReader;
  } = {},
): ExecutionService {
  const parsed = parsePolicy(policyInput);
  if (!parsed.ok) {
    throw new Error(
      parsed.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("; "),
    );
  }
  const policy = parsed.policy;
  const mode = options.mode ?? "development";
  const clock = options.clock ?? Date.now;
  const maxObservationAgeMs = options.maxObservationAgeMs ?? 5_000;
  if (
    !Number.isFinite(maxObservationAgeMs) ||
    maxObservationAgeMs < 1 ||
    !Number.isInteger(maxObservationAgeMs)
  ) {
    throw new RangeError("maxObservationAgeMs must be a positive integer");
  }
  const effect = options.effect;
  const observe = options.observe;
  const read = options.read;
  let armed = false;
  let lastSeen = Number.NEGATIVE_INFINITY;
  const approvals = new Map<string, StoredApproval>();
  const recent = new Map<string, number[]>();

  // Trusted service time: one injected monotonic clock. A non-finite or
  // backward reading fails closed without changing any state.
  function now(): number | undefined {
    const current = clock();
    if (!Number.isFinite(current)) return undefined;
    if (current < lastSeen) return undefined;
    lastSeen = current;
    return current;
  }

  function clockDetail(): string {
    const current = clock();
    if (!Number.isFinite(current)) return "service clock is invalid";
    return "service clock moved backwards";
  }

  function sweepApprovals(current: number, includeExpired: boolean): void {
    for (const [token, approval] of approvals) {
      if (approval.used || (includeExpired && approval.expiresAtMs < current)) {
        approvals.delete(token);
      }
    }
  }

  // Count recent stamps from a filtered copy. Rejected requests never
  // write back, so they cannot erase a spent rate window.
  function recentCount(key: string, current: number): number {
    const windowStart = current - RATE_WINDOW_MS;
    const stamps = recent.get(key) ?? [];
    return stamps.filter((stamp) => stamp > windowStart && stamp <= current)
      .length;
  }

  function recordStamp(key: string, current: number): void {
    const windowStart = current - RATE_WINDOW_MS;
    const stamps = (recent.get(key) ?? []).filter(
      (stamp) => stamp > windowStart && stamp <= current,
    );
    stamps.push(current);
    recent.set(key, stamps);
  }

  async function checkState(
    deviceId: string,
    operation: PolicyOperation,
    current: number,
  ): Promise<ExecutionResult | undefined> {
    const required = operation.requiresState;
    if (!required) return undefined;
    if (!observe) {
      return rejected("device state is unknown");
    }
    let observation: DeviceObservation;
    try {
      observation = await observe(deviceId);
    } catch {
      return rejected("device state is unknown");
    }
    if (
      !isRecord(observation as unknown) ||
      typeof observation.valid !== "boolean" ||
      typeof observation.atMs !== "number" ||
      !Number.isFinite(observation.atMs) ||
      !isRecord(observation.outputs as unknown)
    ) {
      return rejected("device state is unknown");
    }
    if (
      !observation.valid ||
      observation.atMs > current ||
      current - observation.atMs > maxObservationAgeMs
    ) {
      return rejected("device state is unknown");
    }
    const seen = (observation.outputs as Record<string, unknown>)[
      required.output
    ];
    if (typeof seen !== typeof required.equals) {
      return rejected("device state is unknown");
    }
    if (seen !== required.equals) {
      return rejected("state precondition failed");
    }
    return undefined;
  }

  return {
    policyVersion: policy.version,
    mode,
    get armed() {
      return armed;
    },
    arm() {
      armed = true;
    },
    disarm() {
      armed = false;
    },
    issueApproval(input) {
      if (mode === "unattended") {
        return {
          ok: false,
          detail: "unattended mode cannot wait for a human approval",
        };
      }
      const operation = allowedOperation(
        policy,
        input.callerId,
        input.deviceId,
        input.operation,
      );
      if (!operation) {
        return {
          ok: false,
          detail: "caller is not allowed to approve that operation",
        };
      }
      if (!payloadFits(operation, input.payload)) {
        return {
          ok: false,
          detail: "payload is outside the policy range",
        };
      }
      const duration = checkDuration(operation, input.activeMs);
      if (!duration.ok) return duration;
      const ttl = input.ttlMs ?? 30_000;
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 120_000) {
        return { ok: false, detail: "approval lifetime is out of range" };
      }
      const current = now();
      if (current === undefined) return { ok: false, detail: clockDetail() };
      sweepApprovals(current, true);
      if (approvals.size >= MAX_OUTSTANDING_APPROVALS) {
        return { ok: false, detail: "too many outstanding approvals" };
      }
      const token = randomBytes(16).toString("hex");
      approvals.set(token, {
        callerId: input.callerId,
        deviceId: input.deviceId,
        operation: input.operation,
        payloadHash: hashPayload(input.payload),
        activeMs: duration.activeMs,
        policyVersion: policy.version,
        expiresAtMs: current + ttl,
        used: false,
      });
      return {
        ok: true,
        token,
        expiresAtMs: current + ttl,
        policyVersion: policy.version,
      };
    },
    async execute(input: unknown) {
      const parsed = parseRequest(input);
      if (!parsed.ok) return parsed.result;
      const request = parsed.request;
      const operation = allowedOperation(
        policy,
        request.callerId,
        request.deviceId,
        request.operation,
      );
      if (!operation) {
        return rejected("caller, device, or operation is not allowed");
      }
      if (!payloadFits(operation, request.payload)) {
        return rejected("payload is outside the policy range");
      }
      if (operation.access === "read") {
        if (request.activeMs !== undefined) {
          return rejected("active duration does not apply to reads");
        }
        const current = now();
        if (current === undefined) return rejected(clockDetail());
        const blocked = await checkState(request.deviceId, operation, current);
        if (blocked) return blocked;
        const limit = operation.maxPerMinute;
        const key = rateKey(request.deviceId, request.operation);
        if (limit !== undefined && recentCount(key, current) >= limit) {
          return rejected("rate limit exceeded");
        }
        if (!read) {
          return {
            outcome: "failed",
            detail: "no read implementation configured",
          };
        }
        if (limit !== undefined) recordStamp(key, current);
        let data: unknown;
        try {
          data = await read({
            deviceId: request.deviceId,
            operation: request.operation,
          });
        } catch {
          return { outcome: "failed", detail: "read failed" };
        }
        const checked = checkReadValue(operation, data);
        if (!checked.ok) return checked.result;
        return { outcome: "confirmed", detail: "read permitted", data };
      }
      if (mode === "unattended") {
        return rejected("unattended mode does not actuate");
      }
      if (!armed) return rejected("execution service is disarmed");
      const duration = checkDuration(operation, request.activeMs);
      if (!duration.ok) {
        return rejected(duration.detail);
      }
      const current = now();
      if (current === undefined) return rejected(clockDetail());
      sweepApprovals(current, false);
      const blocked = await checkState(request.deviceId, operation, current);
      if (blocked) return blocked;
      if (!effect) {
        return {
          outcome: "failed",
          detail: "no execution implementation configured",
        };
      }
      const token = request.approvalToken;
      if (token === undefined) {
        return rejected("approval is missing or already used");
      }
      if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
        return rejected("approval token is invalid");
      }
      const approval = approvals.get(token);
      if (!approval || approval.used) {
        return rejected("approval is missing or already used");
      }
      if (approval.expiresAtMs < current) {
        return rejected("approval has expired");
      }
      if (
        approval.callerId !== request.callerId ||
        approval.deviceId !== request.deviceId ||
        approval.operation !== request.operation ||
        approval.policyVersion !== policy.version ||
        approval.payloadHash !== hashPayload(request.payload) ||
        approval.activeMs !== duration.activeMs
      ) {
        return rejected("approval does not match this action");
      }
      const limit = operation.maxPerMinute;
      const key = rateKey(request.deviceId, request.operation);
      if (limit !== undefined && recentCount(key, current) >= limit) {
        return rejected("rate limit exceeded");
      }
      approval.used = true;
      if (limit !== undefined) recordStamp(key, current);
      const action: ValidatedAction = {
        callerId: request.callerId,
        deviceId: request.deviceId,
        operation: request.operation,
        payload: request.payload,
        ...(duration.activeMs !== undefined
          ? { activeMs: duration.activeMs }
          : {}),
      };
      let reported: EffectOutcome;
      try {
        reported = await effect(action);
      } catch {
        return { outcome: "unknown", detail: "effect failed after dispatch" };
      }
      if (!isEffectOutcome(reported)) {
        return {
          outcome: "unknown",
          detail: "effect reported an invalid outcome",
        };
      }
      return {
        outcome: reported.outcome,
        detail: reported.detail ?? defaultEffectDetail(reported.outcome),
      };
    },
  };
}

const REQUEST_KEYS = new Set([
  "callerId",
  "deviceId",
  "operation",
  "payload",
  "activeMs",
  "approvalToken",
]);

interface ParsedRequest {
  readonly callerId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly payload: boolean | number | null;
  readonly activeMs?: unknown;
  readonly approvalToken?: unknown;
}

function parseRequest(
  input: unknown,
):
  | { ok: true; request: ParsedRequest }
  | { ok: false; result: ExecutionResult } {
  if (!isRecord(input))
    return { ok: false, result: rejected("malformed request") };
  for (const key of Object.keys(input)) {
    if (!REQUEST_KEYS.has(key)) {
      return {
        ok: false,
        result: rejected(`unknown request field "${key}"`),
      };
    }
  }
  if (
    typeof input.callerId !== "string" ||
    input.callerId.length === 0 ||
    typeof input.deviceId !== "string" ||
    input.deviceId.length === 0 ||
    typeof input.operation !== "string" ||
    input.operation.length === 0
  ) {
    return { ok: false, result: rejected("malformed request") };
  }
  if (
    typeof input.payload !== "boolean" &&
    typeof input.payload !== "number" &&
    input.payload !== null
  ) {
    return { ok: false, result: rejected("malformed request") };
  }
  if (typeof input.payload === "number" && !Number.isFinite(input.payload)) {
    return {
      ok: false,
      result: rejected("payload is outside the policy range"),
    };
  }
  return {
    ok: true,
    request: {
      callerId: input.callerId,
      deviceId: input.deviceId,
      operation: input.operation,
      payload: input.payload,
      ...(input.activeMs !== undefined ? { activeMs: input.activeMs } : {}),
      ...(input.approvalToken !== undefined
        ? { approvalToken: input.approvalToken }
        : {}),
    },
  };
}

type DurationCheck =
  | { readonly ok: true; readonly activeMs: number | undefined }
  | { readonly ok: false; readonly detail: string };

function checkDuration(
  operation: PolicyOperation,
  activeMs: unknown,
): DurationCheck {
  const max = operation.maxActiveMs;
  if (max === "unlimited" || max === undefined) {
    if (activeMs !== undefined) {
      return {
        ok: false,
        detail: "active duration does not apply to an unlimited operation",
      };
    }
    return { ok: true, activeMs: undefined };
  }
  if (activeMs === undefined) {
    return { ok: false, detail: "active duration is required" };
  }
  if (
    typeof activeMs !== "number" ||
    !Number.isInteger(activeMs) ||
    activeMs < 1 ||
    activeMs > max
  ) {
    return {
      ok: false,
      detail: "active duration is outside the policy limit",
    };
  }
  return { ok: true, activeMs };
}

function checkReadValue(
  operation: PolicyOperation,
  data: unknown,
): { ok: true } | { ok: false; result: ExecutionResult } {
  if (operation.value === "boolean") {
    if (typeof data !== "boolean") {
      return {
        ok: false,
        result: { outcome: "failed", detail: "read value has the wrong type" },
      };
    }
    return { ok: true };
  }
  if (typeof data !== "number" || !Number.isFinite(data)) {
    return {
      ok: false,
      result: { outcome: "failed", detail: "read value has the wrong type" },
    };
  }
  if (data < operation.value.min || data > operation.value.max) {
    return {
      ok: false,
      result: {
        outcome: "failed",
        detail: "read value is outside the policy range",
      },
    };
  }
  return { ok: true };
}

function isEffectOutcome(value: unknown): value is EffectOutcome {
  if (!isRecord(value)) return false;
  const outcome = value.outcome;
  const detail = value.detail;
  return (
    (outcome === "confirmed" ||
      outcome === "failed" ||
      outcome === "unknown") &&
    (detail === undefined || typeof detail === "string")
  );
}

function defaultEffectDetail(
  outcome: "confirmed" | "failed" | "unknown",
): string {
  if (outcome === "confirmed") return "applied";
  if (outcome === "failed") return "effect reported failure";
  return "effect did not confirm";
}

function rateKey(deviceId: string, operation: string): string {
  return `${deviceId}/${operation}`;
}

function allowedOperation(
  policy: PolicyDocument,
  callerId: string,
  deviceId: string,
  operationName: string,
): PolicyOperation | undefined {
  const caller = policy.callers.find((item) => item.id === callerId);
  const grant = caller?.allow.find((item) => item.deviceId === deviceId);
  if (!grant?.operations.includes(operationName)) return undefined;
  const device = policy.devices.find((item) => item.id === deviceId);
  return device?.operations.find(
    (operation) => operation.name === operationName,
  );
}

function payloadFits(
  operation: PolicyOperation,
  payload: boolean | number | null,
): boolean {
  if (operation.access === "read") return payload === null;
  if (operation.value === "boolean") return typeof payload === "boolean";
  return (
    typeof payload === "number" &&
    Number.isFinite(payload) &&
    payload >= operation.value.min &&
    payload <= operation.value.max
  );
}

function hashPayload(payload: boolean | number | null): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function rejected(detail: string): ExecutionResult {
  return { outcome: "rejected", detail };
}
