import { describe, expect, it } from "vitest";
import {
  createExecutionService,
  modelProcessOpen,
  modelProcessShell,
  parsePolicy,
  type ExecutionRequest,
} from "./index.js";

const policy = {
  version: 3,
  callers: [
    {
      id: "dev",
      allow: [{ deviceId: "host-led", operations: ["level", "set"] }],
    },
  ],
  devices: [
    {
      id: "host-led",
      operations: [
        { name: "level", access: "read", value: "boolean" },
        {
          name: "set",
          access: "actuate",
          value: "boolean",
          maxActiveMs: 2000,
          maxPerMinute: 2,
        },
      ],
    },
  ],
};

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    callerId: "dev",
    deviceId: "host-led",
    operation: "set",
    payload: true,
    activeMs: 1000,
    nowMs: 10_000,
    ...overrides,
  };
}

describe("execution policy", () => {
  it("stays disarmed until armed, and a read does not apply an output", () => {
    const applied: unknown[] = [];
    const service = createExecutionService(policy, {
      effect: (item) => applied.push(item),
    });
    expect(service.armed).toBe(false);
    expect(service.execute(request()).outcome).toBe("rejected");
    expect(applied).toEqual([]);
    expect(
      service.execute(
        request({ operation: "level", payload: null, activeMs: undefined }),
      ),
    ).toEqual({
      outcome: "confirmed",
      detail: "read permitted",
    });
    expect(applied).toEqual([]);
  });

  it("binds an approval to one payload and burns it on use", () => {
    const applied: boolean[] = [];
    const service = createExecutionService(policy, {
      effect: (item) => applied.push(item.payload === true),
    });
    service.arm();
    const grant = service.issueApproval({
      callerId: "dev",
      deviceId: "host-led",
      operation: "set",
      payload: true,
      nowMs: 10_000,
    });
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    expect(
      service.execute(request({ payload: false, approvalToken: grant.token }))
        .detail,
    ).toMatch(/does not match/);
    expect(applied).toEqual([]);
    expect(
      service.execute(request({ approvalToken: grant.token })).outcome,
    ).toBe("confirmed");
    expect(
      service.execute(request({ approvalToken: grant.token })).detail,
    ).toMatch(/already used/);
    expect(applied).toEqual([true]);
  });

  it("rejects an expired approval, an unknown caller, and a malformed request", () => {
    const service = createExecutionService(policy);
    service.arm();
    const grant = service.issueApproval({
      callerId: "dev",
      deviceId: "host-led",
      operation: "set",
      payload: true,
      nowMs: 1_000,
      ttlMs: 1_000,
    });
    if (!grant.ok) throw new Error("expected an approval");
    expect(
      service.execute(request({ nowMs: 2_001, approvalToken: grant.token }))
        .detail,
    ).toMatch(/expired/);
    expect(
      service.execute(
        request({ callerId: "other", approvalToken: grant.token }),
      ).detail,
    ).toMatch(/not allowed/);
    expect(service.execute({ callerId: "dev", payload: true }).outcome).toBe(
      "rejected",
    );
  });

  it("rejects shell bypass, device opens, and a policy edited after load", () => {
    expect(() => modelProcessShell()).toThrow(/shell/);
    expect(() => modelProcessOpen("/dev/gpiochip0")).toThrow(/device files/);
    expect(() => modelProcessOpen("/etc/november/broker-password")).toThrow(
      /credentials/,
    );

    const input = structuredClone(policy);
    const service = createExecutionService(input);
    input.devices[0]?.operations[1] &&
      Object.assign(input.devices[0].operations[1], {
        maxActiveMs: 86_400_000,
      });
    service.arm();
    const grant = service.issueApproval({
      callerId: "dev",
      deviceId: "host-led",
      operation: "set",
      payload: true,
      nowMs: 10_000,
    });
    if (!grant.ok) throw new Error("expected an approval");
    expect(
      service.execute(request({ activeMs: 50_000, approvalToken: grant.token }))
        .detail,
    ).toMatch(/duration/);
    expect(
      service.execute({
        ...request(),
        operation: "shell",
        approvalToken: grant.token,
      }).detail,
    ).toMatch(/not available/);
    expect(
      service.execute({
        ...request(),
        command: "id",
        approvalToken: grant.token,
      }).detail,
    ).toMatch(/not available/);
  });

  it("does not wait for a person in unattended mode and enforces rate and range", () => {
    const unattended = createExecutionService(policy, { mode: "unattended" });
    expect(
      unattended.issueApproval({
        callerId: "dev",
        deviceId: "host-led",
        operation: "set",
        payload: true,
        nowMs: 1,
      }),
    ).toEqual({
      ok: false,
      detail: "unattended mode cannot wait for a human approval",
    });

    const limited = {
      ...policy,
      version: 4,
      devices: [
        {
          id: "host-led",
          operations: [
            {
              name: "set",
              access: "actuate" as const,
              value: "boolean" as const,
              maxPerMinute: 1,
            },
          ],
        },
      ],
    };
    const service = createExecutionService(limited);
    service.arm();
    const first = service.issueApproval({
      callerId: "dev",
      deviceId: "host-led",
      operation: "set",
      payload: true,
      nowMs: 1_000,
    });
    const second = service.issueApproval({
      callerId: "dev",
      deviceId: "host-led",
      operation: "set",
      payload: false,
      nowMs: 1_100,
    });
    if (!first.ok || !second.ok) throw new Error("expected approvals");
    expect(
      service.execute(request({ nowMs: 1_000, approvalToken: first.token }))
        .outcome,
    ).toBe("confirmed");
    expect(
      service.execute(
        request({
          payload: false,
          nowMs: 1_100,
          approvalToken: second.token,
          activeMs: undefined,
        }),
      ).detail,
    ).toMatch(/rate/);

    const ranged = createExecutionService({
      version: 5,
      callers: [
        { id: "dev", allow: [{ deviceId: "meter", operations: ["level"] }] },
      ],
      devices: [
        {
          id: "meter",
          operations: [
            {
              name: "level",
              access: "actuate",
              value: { type: "number", min: 0, max: 100 },
              requiresState: 0,
            },
          ],
        },
      ],
    });
    ranged.arm();
    const grant = ranged.issueApproval({
      callerId: "dev",
      deviceId: "meter",
      operation: "level",
      payload: 10,
      nowMs: 5,
    });
    if (!grant.ok) throw new Error("expected an approval");
    expect(
      ranged.execute({
        callerId: "dev",
        deviceId: "meter",
        operation: "level",
        payload: 101,
        approvalToken: grant.token,
        nowMs: 5,
      }).detail,
    ).toMatch(/range/);
    expect(
      ranged.execute({
        callerId: "dev",
        deviceId: "meter",
        operation: "level",
        payload: 10,
        approvalToken: grant.token,
        nowMs: 5,
      }).outcome,
    ).toBe("confirmed");
  });

  it("rejects an unknown policy field before the service starts", () => {
    const parsed = parsePolicy({ ...policy, note: "edited" });
    expect(parsed.ok).toBe(false);
    expect(() => createExecutionService({ ...policy, note: "edited" })).toThrow(
      /note/,
    );
  });
});
