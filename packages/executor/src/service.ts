/**
 * Privileged execution checks. The model does not receive this object's
 * policy or the effect callback. An approval token is single-use and is
 * bound to the caller, device, operation, payload, and policy version.
 */
import { createHash, randomBytes } from "node:crypto";
import type { ActionOutcome } from "@november/core";
import {
  blockedOperation,
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
  readonly nowMs: number;
}

export interface ExecutionResult {
  readonly outcome: ActionOutcome;
  readonly detail: string;
}

export interface ApprovalGrant {
  readonly ok: true;
  readonly token: string;
  readonly expiresAtMs: number;
  readonly policyVersion: number;
}

interface StoredApproval {
  readonly callerId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly payloadHash: string;
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
    readonly nowMs: number;
    readonly ttlMs?: number;
  }): ApprovalGrant | { readonly ok: false; readonly detail: string };
  execute(request: unknown): ExecutionResult;
}

export function createExecutionService(
  policyInput: unknown,
  options: {
    readonly mode?: ServiceMode;
    readonly effect?: (request: ExecutionRequest) => void;
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
  const effect = options.effect ?? (() => undefined);
  let armed = false;
  const approvals = new Map<string, StoredApproval>();
  const state = new Map<string, boolean | number>();
  const recent = new Map<string, number[]>();
  for (const device of policy.devices) {
    const actuate = device.operations.find(
      (operation) => operation.access === "actuate",
    );
    if (!actuate) continue;
    state.set(
      device.id,
      actuate.value === "boolean" ? false : actuate.value.min,
    );
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
      if (!operation)
        return {
          ok: false,
          detail: "caller is not allowed to approve that operation",
        };
      const ttl = input.ttlMs ?? 30_000;
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 120_000) {
        return { ok: false, detail: "approval lifetime is out of range" };
      }
      const token = randomBytes(16).toString("hex");
      approvals.set(token, {
        callerId: input.callerId,
        deviceId: input.deviceId,
        operation: input.operation,
        payloadHash: hashPayload(input.payload),
        policyVersion: policy.version,
        expiresAtMs: input.nowMs + ttl,
        used: false,
      });
      return {
        ok: true,
        token,
        expiresAtMs: input.nowMs + ttl,
        policyVersion: policy.version,
      };
    },
    execute(input: unknown) {
      if (!isRecord(input) || !isRequest(input))
        return rejected("malformed request");
      if (
        blockedOperation(input.operation) ||
        "command" in input ||
        "path" in input ||
        "shell" in input
      ) {
        return rejected("operation is not available to the model");
      }
      const request = input;
      const operation = allowedOperation(
        policy,
        request.callerId,
        request.deviceId,
        request.operation,
      );
      if (!operation)
        return rejected("caller, device, or operation is not allowed");
      if (!payloadFits(operation, request.payload))
        return rejected("payload is outside the policy range");
      if (operation.access === "read") {
        return { outcome: "confirmed", detail: "read permitted" };
      }
      if (!armed) return rejected("execution service is disarmed");
      if (operation.maxActiveMs !== undefined) {
        if (
          request.activeMs === undefined ||
          !Number.isInteger(request.activeMs) ||
          request.activeMs < 1 ||
          request.activeMs > operation.maxActiveMs
        ) {
          return rejected("active duration is outside the policy limit");
        }
      }
      if (
        operation.requiresState !== undefined &&
        state.get(request.deviceId) !== operation.requiresState
      ) {
        return rejected("state precondition failed");
      }
      const limit = operation.maxPerMinute;
      if (limit !== undefined && recentCount(recent, request, limit) >= limit) {
        return rejected("rate limit exceeded");
      }
      const approval = request.approvalToken
        ? approvals.get(request.approvalToken)
        : undefined;
      if (!approval || approval.used)
        return rejected("approval is missing or already used");
      if (approval.expiresAtMs < request.nowMs)
        return rejected("approval has expired");
      if (
        approval.callerId !== request.callerId ||
        approval.deviceId !== request.deviceId ||
        approval.operation !== request.operation ||
        approval.policyVersion !== policy.version ||
        approval.payloadHash !== hashPayload(request.payload)
      ) {
        return rejected("approval does not match this action");
      }
      approval.used = true;
      effect(request);
      if (
        typeof request.payload === "boolean" ||
        typeof request.payload === "number"
      ) {
        state.set(request.deviceId, request.payload);
      }
      const key = rateKey(request);
      const stamps = recent.get(key) ?? [];
      stamps.push(request.nowMs);
      recent.set(key, stamps);
      return { outcome: "confirmed", detail: "applied" };
    },
  };
}

function recentCount(
  recent: Map<string, number[]>,
  request: ExecutionRequest,
  _limit: number,
): number {
  const key = rateKey(request);
  const windowStart = request.nowMs - 60_000;
  const stamps = (recent.get(key) ?? []).filter(
    (stamp) => stamp > windowStart && stamp <= request.nowMs,
  );
  recent.set(key, stamps);
  return stamps.length;
}

function rateKey(request: ExecutionRequest): string {
  return `${request.deviceId}/${request.operation}`;
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

function isRequest(
  value: Record<string, unknown>,
): value is ExecutionRequest & Record<string, unknown> {
  return (
    typeof value.callerId === "string" &&
    typeof value.deviceId === "string" &&
    typeof value.operation === "string" &&
    (typeof value.payload === "boolean" ||
      typeof value.payload === "number" ||
      value.payload === null) &&
    typeof value.nowMs === "number" &&
    Number.isFinite(value.nowMs)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
