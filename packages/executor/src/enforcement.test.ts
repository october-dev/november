import { describe, expect, it } from "vitest";
import {
  createExecutionService,
  parsePolicy,
  type DeviceObservation,
  type DeviceObserver,
  type ExecutionRequest,
  type ValidatedAction,
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
    ...overrides,
  };
}

function time(start = 0): { now: () => number; set: (next: number) => void } {
  let current = start;
  return {
    now: () => current,
    set: (next: number) => {
      current = next;
    },
  };
}

function approve(
  service: ReturnType<typeof createExecutionService>,
  overrides: Record<string, unknown> = {},
): string {
  const grant = service.issueApproval({
    callerId: "dev",
    deviceId: "host-led",
    operation: "set",
    payload: true,
    activeMs: 1000,
    ...overrides,
  });
  if (!grant.ok) throw new Error(`expected an approval: ${grant.detail}`);
  return grant.token;
}

describe("execution policy", () => {
  it("stays disarmed until armed, and reads obtain data through the read path", async () => {
    const applied: unknown[] = [];
    const service = createExecutionService(policy, {
      clock: time(10_000).now,
      effect: (item) => {
        applied.push(item);
        return { outcome: "confirmed" };
      },
      read: () => true,
    });
    expect(service.armed).toBe(false);
    expect((await service.execute(request())).outcome).toBe("rejected");
    expect(applied).toEqual([]);
    expect(
      await service.execute(
        request({ operation: "level", payload: null, activeMs: undefined }),
      ),
    ).toEqual({
      outcome: "confirmed",
      detail: "read permitted",
      data: true,
    });
    expect(applied).toEqual([]);

    const noRead = createExecutionService(policy, { clock: time(10_000).now });
    expect(
      await noRead.execute(
        request({ operation: "level", payload: null, activeMs: undefined }),
      ),
    ).toEqual({
      outcome: "failed",
      detail: "no read implementation configured",
    });

    const noEffect = createExecutionService(policy, {
      clock: time(10_000).now,
      read: () => true,
    });
    noEffect.arm();
    const grant = noEffect.issueApproval({
      callerId: "dev",
      deviceId: "host-led",
      operation: "set",
      payload: true,
      activeMs: 1000,
    });
    if (!grant.ok) throw new Error("expected an approval");
    expect(
      await noEffect.execute(request({ approvalToken: grant.token })),
    ).toEqual({
      outcome: "failed",
      detail: "no execution implementation configured",
    });
  });

  it("binds an approval to one payload and duration, and burns it on use", async () => {
    const applied: ValidatedAction[] = [];
    const service = createExecutionService(policy, {
      clock: time(10_000).now,
      effect: (item) => {
        applied.push(item);
        return { outcome: "confirmed" };
      },
    });
    service.arm();
    const token = approve(service);
    expect(
      (await service.execute(request({ payload: false, approvalToken: token })))
        .detail,
    ).toMatch(/does not match/);
    expect(
      (await service.execute(request({ activeMs: 1500, approvalToken: token })))
        .detail,
    ).toMatch(/does not match/);
    expect(applied).toEqual([]);
    expect(
      (await service.execute(request({ approvalToken: token }))).outcome,
    ).toBe("confirmed");
    expect(applied).toEqual([
      {
        callerId: "dev",
        deviceId: "host-led",
        operation: "set",
        payload: true,
        activeMs: 1000,
      },
    ]);
    expect(
      (await service.execute(request({ approvalToken: token }))).detail,
    ).toMatch(/already used/);
    expect(
      service.issueApproval({
        callerId: "dev",
        deviceId: "host-led",
        operation: "set",
        payload: true,
      }),
    ).toMatchObject({ ok: false, detail: "active duration is required" });
  });

  it("expires approvals at the service clock, with the boundary valid", async () => {
    const clock = time(1_000);
    const service = createExecutionService(policy, {
      clock: clock.now,
      effect: () => ({ outcome: "confirmed" }),
    });
    service.arm();
    const first = service.issueApproval({
      callerId: "dev",
      deviceId: "host-led",
      operation: "set",
      payload: true,
      activeMs: 1000,
      ttlMs: 1_000,
    });
    const second = service.issueApproval({
      callerId: "dev",
      deviceId: "host-led",
      operation: "set",
      payload: true,
      activeMs: 1000,
      ttlMs: 1_000,
    });
    if (!first.ok || !second.ok) throw new Error("expected approvals");
    clock.set(2_000);
    expect(
      (await service.execute(request({ approvalToken: first.token }))).outcome,
    ).toBe("confirmed");
    clock.set(2_001);
    expect(
      (await service.execute(request({ approvalToken: second.token }))).detail,
    ).toMatch(/expired/);
  });

  it("fails closed on a non-finite or backward clock", async () => {
    const broken = createExecutionService(policy, {
      clock: () => Number.NaN,
      effect: () => ({ outcome: "confirmed" }),
    });
    broken.arm();
    expect(
      broken.issueApproval({
        callerId: "dev",
        deviceId: "host-led",
        operation: "set",
        payload: true,
        activeMs: 1000,
      }),
    ).toMatchObject({ ok: false, detail: "service clock is invalid" });
    expect(await broken.execute(request())).toMatchObject({
      outcome: "rejected",
      detail: "service clock is invalid",
    });

    const clock = time(1_000);
    const service = createExecutionService(policy, {
      clock: clock.now,
      effect: () => ({ outcome: "confirmed" }),
    });
    service.arm();
    const token = approve(service);
    clock.set(500);
    expect(
      await service.execute(request({ approvalToken: token })),
    ).toMatchObject({
      outcome: "rejected",
      detail: "service clock moved backwards",
    });
    clock.set(1_500);
    expect(
      (await service.execute(request({ approvalToken: token }))).outcome,
    ).toBe("confirmed");
  });

  it("rejects unknown callers, operations, fields, and token shapes", async () => {
    const service = createExecutionService(policy, {
      clock: time(10_000).now,
      effect: () => ({ outcome: "confirmed" }),
    });
    service.arm();
    const token = approve(service);
    expect(
      (
        await service.execute(
          request({ callerId: "other", approvalToken: token }),
        )
      ).detail,
    ).toMatch(/not allowed/);
    expect(
      (await service.execute({ ...request(), operation: "shell" })).detail,
    ).toMatch(/not allowed/);
    expect(
      (await service.execute({ callerId: "dev", payload: true })).outcome,
    ).toBe("rejected");
    for (const extra of ["command", "path", "shell", "exec", "pin", "nowMs"]) {
      expect(
        (await service.execute({ ...request(), [extra]: "id" })).detail,
        extra,
      ).toMatch(/unknown request field/);
    }
    expect(
      (await service.execute(request({ approvalToken: 123 as never }))).detail,
    ).toBe("approval token is invalid");
    expect(
      (await service.execute(request({ approvalToken: "not-a-token" }))).detail,
    ).toBe("approval token is invalid");
    expect(
      (
        await service.execute(
          request({ approvalToken: "f".repeat(32), activeMs: 1000 }),
        )
      ).detail,
    ).toMatch(/missing or already used/);
  });

  it("refuses approval binding across callers, devices, and payloads", async () => {
    const shared = {
      version: 3,
      callers: [
        {
          id: "dev",
          allow: [
            { deviceId: "host-led", operations: ["set"] },
            { deviceId: "aux-led", operations: ["set"] },
          ],
        },
        {
          id: "other",
          allow: [{ deviceId: "host-led", operations: ["set"] }],
        },
      ],
      devices: [
        {
          id: "host-led",
          operations: [
            {
              name: "set",
              access: "actuate",
              value: "boolean",
              maxActiveMs: 2000,
            },
          ],
        },
        {
          id: "aux-led",
          operations: [
            {
              name: "set",
              access: "actuate",
              value: "boolean",
              maxActiveMs: 2000,
            },
          ],
        },
      ],
    };
    const service = createExecutionService(shared, {
      clock: time(10_000).now,
      effect: () => ({ outcome: "confirmed" }),
    });
    service.arm();
    const token = approve(service);
    expect(
      (
        await service.execute(
          request({ callerId: "other", approvalToken: token }),
        )
      ).detail,
    ).toMatch(/does not match/);
    expect(
      (
        await service.execute(
          request({ deviceId: "aux-led", approvalToken: token }),
        )
      ).detail,
    ).toMatch(/does not match/);
  });

  it("does not actuate in unattended mode, but still reads", async () => {
    const unattended = createExecutionService(policy, {
      mode: "unattended",
      clock: time(1).now,
      effect: () => ({ outcome: "confirmed" }),
      read: () => true,
    });
    expect(
      unattended.issueApproval({
        callerId: "dev",
        deviceId: "host-led",
        operation: "set",
        payload: true,
        activeMs: 1000,
      }),
    ).toEqual({
      ok: false,
      detail: "unattended mode cannot wait for a human approval",
    });
    unattended.arm();
    expect(await unattended.execute(request())).toMatchObject({
      outcome: "rejected",
      detail: "unattended mode does not actuate",
    });
    expect(
      await unattended.execute(
        request({ operation: "level", payload: null, activeMs: undefined }),
      ),
    ).toMatchObject({ outcome: "confirmed", data: true });
  });

  it("enforces the rate window without letting rejected requests erase it", async () => {
    const limited = {
      ...policy,
      version: 4,
      devices: [
        {
          id: "host-led",
          operations: [
            {
              name: "level",
              access: "read" as const,
              value: "boolean" as const,
            },
            {
              name: "set",
              access: "actuate" as const,
              value: "boolean" as const,
              maxActiveMs: 2000,
              maxPerMinute: 1,
            },
          ],
        },
      ],
    };
    const clock = time(1_000);
    const service = createExecutionService(limited, {
      clock: clock.now,
      effect: () => ({ outcome: "confirmed" }),
    });
    service.arm();
    const first = approve(service);
    expect(
      (await service.execute(request({ approvalToken: first }))).outcome,
    ).toBe("confirmed");
    const second = approve(service, { ttlMs: 120_000 });
    clock.set(2_000);
    expect(
      (
        await service.execute(
          request({ approvalToken: "e".repeat(32), activeMs: 1000 }),
        )
      ).detail,
    ).toMatch(/missing or already used/);
    expect(
      (await service.execute(request({ approvalToken: second }))).detail,
    ).toMatch(/rate limit exceeded/);
    clock.set(62_000);
    expect(
      (await service.execute(request({ approvalToken: second }))).outcome,
    ).toBe("confirmed");
  });

  it("propagates effect evidence and retains the rate on uncertain dispatch", async () => {
    const limited = {
      ...policy,
      version: 4,
      callers: [
        {
          id: "dev",
          allow: [{ deviceId: "host-led", operations: ["set"] }],
        },
      ],
      devices: [
        {
          id: "host-led",
          operations: [
            {
              name: "set",
              access: "actuate" as const,
              value: "boolean" as const,
              maxActiveMs: 2000,
              maxPerMinute: 1,
            },
          ],
        },
      ],
    };
    const clock = time(1_000);
    let mode: "throw" | "unknown" | "invalid" | "ok" = "throw";
    const service = createExecutionService(limited, {
      clock: clock.now,
      effect: async (item) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (item.payload !== true) throw new Error("unreachable");
        if (mode === "throw") throw new Error("acted, then lost the reply");
        if (mode === "unknown") return { outcome: "unknown" as const };
        if (mode === "invalid") return { outcome: "bogus" } as never;
        return { outcome: "confirmed" as const, detail: "applied by test rig" };
      },
    });
    service.arm();
    expect(
      await service.execute(request({ approvalToken: approve(service) })),
    ).toMatchObject({
      outcome: "unknown",
      detail: "effect failed after dispatch",
    });
    expect(
      (await service.execute(request({ approvalToken: approve(service) })))
        .detail,
    ).toMatch(/rate limit exceeded/);

    clock.set(62_000);
    mode = "unknown";
    expect(
      await service.execute(request({ approvalToken: approve(service) })),
    ).toMatchObject({ outcome: "unknown", detail: "effect did not confirm" });

    clock.set(123_000);
    mode = "invalid";
    expect(
      await service.execute(request({ approvalToken: approve(service) })),
    ).toMatchObject({
      outcome: "unknown",
      detail: "effect reported an invalid outcome",
    });

    clock.set(184_000);
    mode = "ok";
    expect(
      await service.execute(request({ approvalToken: approve(service) })),
    ).toMatchObject({ outcome: "confirmed", detail: "applied by test rig" });
  });

  it("checks numeric ranges and validates durations, even malformed ones", async () => {
    const clock = time(5);
    const ranged = createExecutionService(
      {
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
                maxActiveMs: 2000,
                requiresState: { output: "level", equals: 0 },
              },
            ],
          },
        ],
      },
      {
        clock: clock.now,
        effect: () => ({ outcome: "confirmed" }),
        observe: () => ({ outputs: { level: 0 }, atMs: 5, valid: true }),
      },
    );
    ranged.arm();
    const grant = ranged.issueApproval({
      callerId: "dev",
      deviceId: "meter",
      operation: "level",
      payload: 10,
      activeMs: 1000,
    });
    if (!grant.ok) throw new Error("expected an approval");
    const base = {
      callerId: "dev",
      deviceId: "meter",
      operation: "level",
      approvalToken: grant.token,
    };
    expect(
      (await ranged.execute({ ...base, payload: 101, activeMs: 1000 })).detail,
    ).toMatch(/range/);
    expect(
      (await ranged.execute({ ...base, payload: 10, activeMs: "forever" }))
        .detail,
    ).toMatch(/outside the policy limit/);
    expect((await ranged.execute({ ...base, payload: 10 })).detail).toBe(
      "active duration is required",
    );
    expect(
      (await ranged.execute({ ...base, payload: 10, activeMs: 1000 })).outcome,
    ).toBe("confirmed");
  });

  it("supports an explicit unlimited duration without a bound approval", async () => {
    const service = createExecutionService(
      {
        version: 6,
        callers: [
          {
            id: "dev",
            allow: [{ deviceId: "host-led", operations: ["glow"] }],
          },
        ],
        devices: [
          {
            id: "host-led",
            operations: [
              {
                name: "glow",
                access: "actuate",
                value: "boolean",
                maxActiveMs: "unlimited",
              },
            ],
          },
        ],
      },
      {
        clock: time(10_000).now,
        effect: () => ({ outcome: "confirmed" }),
      },
    );
    service.arm();
    expect(
      service.issueApproval({
        callerId: "dev",
        deviceId: "host-led",
        operation: "glow",
        payload: true,
        activeMs: 1000,
      }),
    ).toMatchObject({ ok: false });
    const grant = service.issueApproval({
      callerId: "dev",
      deviceId: "host-led",
      operation: "glow",
      payload: true,
    });
    if (!grant.ok) throw new Error("expected an approval");
    expect(
      (
        await service.execute({
          callerId: "dev",
          deviceId: "host-led",
          operation: "glow",
          payload: true,
          activeMs: 1000,
          approvalToken: grant.token,
        })
      ).detail,
    ).toMatch(/unlimited/);
    expect(
      (
        await service.execute({
          callerId: "dev",
          deviceId: "host-led",
          operation: "glow",
          payload: true,
          approvalToken: grant.token,
        })
      ).outcome,
    ).toBe("confirmed");
  });

  it("reads state preconditions from observations on two outputs", async () => {
    const stateful = {
      version: 7,
      callers: [
        {
          id: "dev",
          allow: [{ deviceId: "pump", operations: ["on", "off", "fan"] }],
        },
      ],
      devices: [
        {
          id: "pump",
          operations: [
            {
              name: "on",
              access: "actuate",
              value: "boolean",
              maxActiveMs: 2000,
              requiresState: { output: "on", equals: false },
            },
            {
              name: "off",
              access: "actuate",
              value: "boolean",
              maxActiveMs: 2000,
              requiresState: { output: "on", equals: true },
            },
            {
              name: "fan",
              access: "actuate",
              value: "boolean",
              maxActiveMs: 2000,
              requiresState: { output: "on", equals: false },
            },
          ],
        },
      ],
    };
    const clock = time(0);
    const observed: Record<string, boolean | number> = {
      on: false,
      fan: false,
    };
    const service = createExecutionService(stateful, {
      clock: clock.now,
      effect: () => ({ outcome: "confirmed" }),
      observe: (): DeviceObservation => ({
        outputs: observed,
        atMs: clock.now(),
        valid: true,
      }),
    });
    service.arm();
    const run = async (operation: string): Promise<string> => {
      const grant = service.issueApproval({
        callerId: "dev",
        deviceId: "pump",
        operation,
        payload: true,
        activeMs: 1000,
      });
      if (!grant.ok) throw new Error(`expected an approval: ${grant.detail}`);
      const result = await service.execute({
        callerId: "dev",
        deviceId: "pump",
        operation,
        payload: true,
        activeMs: 1000,
        approvalToken: grant.token,
      });
      return `${result.outcome}:${result.detail}`;
    };
    expect(await run("on")).toMatch(/^confirmed/);
    observed.on = true;
    expect(await run("on")).toMatch(/state precondition failed/);
    expect(await run("fan")).toMatch(/state precondition failed/);
    expect(await run("off")).toMatch(/^confirmed/);
    observed.on = false;
    expect(await run("fan")).toMatch(/^confirmed/);
    // An autonomous change is observed, not assumed from the last command.
    observed.on = true;
    expect(await run("fan")).toMatch(/state precondition failed/);
  });

  it("treats missing, stale, future, and mistyped observations as unknown", async () => {
    const stateful = {
      version: 7,
      callers: [
        { id: "dev", allow: [{ deviceId: "pump", operations: ["on"] }] },
      ],
      devices: [
        {
          id: "pump",
          operations: [
            {
              name: "on",
              access: "actuate",
              value: "boolean",
              maxActiveMs: 2000,
              requiresState: { output: "on", equals: false },
            },
          ],
        },
      ],
    };
    const attempt = async (
      observe: DeviceObserver | undefined,
      now: number,
    ): Promise<string> => {
      const clock = time(now);
      const service = createExecutionService(stateful, {
        clock: clock.now,
        effect: () => ({ outcome: "confirmed" }),
        ...(observe ? { observe } : {}),
      });
      service.arm();
      const grant = service.issueApproval({
        callerId: "dev",
        deviceId: "pump",
        operation: "on",
        payload: true,
        activeMs: 1000,
      });
      if (!grant.ok) throw new Error(`expected an approval: ${grant.detail}`);
      const result = await service.execute({
        callerId: "dev",
        deviceId: "pump",
        operation: "on",
        payload: true,
        activeMs: 1000,
        approvalToken: grant.token,
      });
      return `${result.outcome}:${result.detail}`;
    };
    const at =
      (
        outputs: Record<string, boolean | number>,
        atMs: number,
        valid: boolean,
      ): DeviceObserver =>
      () => ({ outputs, atMs, valid });
    expect(await attempt(undefined, 1000)).toMatch(/device state is unknown/);
    expect(await attempt(at({ on: false }, 1000, false), 1000)).toMatch(
      /device state is unknown/,
    );
    expect(await attempt(at({ on: false }, 0, true), 10_000)).toMatch(
      /device state is unknown/,
    );
    expect(await attempt(at({ on: false }, 2_000, true), 1_000)).toMatch(
      /device state is unknown/,
    );
    expect(await attempt(at({ on: 5 }, 1_000, true), 1_000)).toMatch(
      /device state is unknown/,
    );
    expect(await attempt(at({}, 1_000, true), 1_000)).toMatch(
      /device state is unknown/,
    );
  });

  it("enforces rate limits and value checks on reads", async () => {
    const clock = time(0);
    let value: unknown = 42;
    const service = createExecutionService(
      {
        version: 8,
        callers: [
          { id: "dev", allow: [{ deviceId: "sensor", operations: ["temp"] }] },
        ],
        devices: [
          {
            id: "sensor",
            operations: [
              {
                name: "temp",
                access: "read",
                value: { type: "number", min: 0, max: 100 },
                maxPerMinute: 1,
              },
            ],
          },
        ],
      },
      { clock: clock.now, read: () => value },
    );
    const read = () =>
      service.execute({
        callerId: "dev",
        deviceId: "sensor",
        operation: "temp",
        payload: null,
      });
    expect(await read()).toMatchObject({ outcome: "confirmed", data: 42 });
    expect((await read()).detail).toMatch(/rate limit exceeded/);
    clock.set(61_000);
    value = "warm";
    expect((await read()).detail).toMatch(/wrong type/);
    clock.set(122_000);
    value = 101;
    expect((await read()).detail).toMatch(/outside the policy range/);
    clock.set(183_000);
    expect(
      (
        await service.execute({
          callerId: "dev",
          deviceId: "sensor",
          operation: "temp",
          payload: null,
          activeMs: 100,
        })
      ).detail,
    ).toMatch(/does not apply to reads/);
  });

  it("bounds outstanding approvals and reclaims them on use", () => {
    const service = createExecutionService(policy, { clock: time(1_000).now });
    const tokens: string[] = [];
    for (let i = 0; i < 128; i += 1) {
      const grant = service.issueApproval({
        callerId: "dev",
        deviceId: "host-led",
        operation: "set",
        payload: true,
        activeMs: 1000,
        ttlMs: 120_000,
      });
      if (!grant.ok) throw new Error(`expected approval ${i}: ${grant.detail}`);
      tokens.push(grant.token);
    }
    expect(
      service.issueApproval({
        callerId: "dev",
        deviceId: "host-led",
        operation: "set",
        payload: true,
        activeMs: 1000,
        ttlMs: 120_000,
      }),
    ).toMatchObject({ ok: false, detail: "too many outstanding approvals" });
    expect(new Set(tokens).size).toBe(128);
  });

  it("rejects ambiguous policy definitions and dangling references", () => {
    const dupCaller = structuredClone(policy);
    dupCaller.callers.push(structuredClone(dupCaller.callers[0]) as never);
    expect(parsePolicy(dupCaller).ok).toBe(false);

    const dupDevice = structuredClone(policy);
    dupDevice.devices.push(structuredClone(dupDevice.devices[0]) as never);
    expect(
      (parsePolicy(dupDevice) as { ok: false; errors: { path: string }[] })
        .errors,
    ).toContainEqual({
      path: "devices[1].id",
      message: "device id is already defined",
    });

    const dupOperation = structuredClone(policy);
    (
      dupOperation.devices[0] as never as { operations: unknown[] }
    ).operations.push(
      structuredClone(
        (dupOperation.devices[0] as never as { operations: unknown[] })
          .operations[0],
      ),
    );
    expect(parsePolicy(dupOperation).ok).toBe(false);

    const danglingDevice = structuredClone(policy);
    (
      danglingDevice.callers[0] as never as {
        allow: { deviceId: string; operations: string[] }[];
      }
    ).allow[0].deviceId = "missing-led";
    expect(
      (parsePolicy(danglingDevice) as { ok: false; errors: { path: string }[] })
        .errors,
    ).toContainEqual({
      path: "callers[0].allow[0].deviceId",
      message: "device is not defined",
    });

    const danglingOperation = structuredClone(policy);
    (
      danglingOperation.callers[0] as never as {
        allow: { deviceId: string; operations: string[] }[];
      }
    ).allow[0].operations = ["missing"];
    expect(parsePolicy(danglingOperation).ok).toBe(false);

    const missingMax = structuredClone(policy);
    delete (
      missingMax.devices[0] as never as {
        operations: { maxActiveMs?: unknown }[];
      }
    ).operations[1].maxActiveMs;
    expect(
      (parsePolicy(missingMax) as { ok: false; errors: { message: string }[] })
        .errors[0]?.message,
    ).toMatch(/is required/);

    const readMax = structuredClone(policy);
    (
      readMax.devices[0] as never as { operations: { maxActiveMs?: unknown }[] }
    ).operations[0].maxActiveMs = 1000;
    expect(parsePolicy(readMax).ok).toBe(false);

    const badRequirement = {
      version: 1,
      callers: [{ id: "dev", allow: [{ deviceId: "d", operations: ["set"] }] }],
      devices: [
        {
          id: "d",
          operations: [
            {
              name: "set",
              access: "actuate",
              value: "boolean",
              maxActiveMs: 1000,
              requiresState: { output: "set", equals: 7 },
            },
          ],
        },
      ],
    };
    expect(
      (
        parsePolicy(badRequirement) as {
          ok: false;
          errors: { message: string }[];
        }
      ).errors[0]?.message,
    ).toMatch(/must be a boolean/);
  });

  it("rejects an unknown policy field before the service starts", () => {
    const parsed = parsePolicy({ ...policy, note: "edited" });
    expect(parsed.ok).toBe(false);
    expect(() => createExecutionService({ ...policy, note: "edited" })).toThrow(
      /note/,
    );
  });

  it("ignores a policy object edited after load", async () => {
    const input = structuredClone(policy);
    const service = createExecutionService(input, {
      clock: time(10_000).now,
      effect: () => ({ outcome: "confirmed" }),
    });
    Object.assign(
      (input.devices[0] as never as { operations: { maxActiveMs?: unknown }[] })
        .operations[1],
      { maxActiveMs: 86_400_000 },
    );
    service.arm();
    const grant = service.issueApproval({
      callerId: "dev",
      deviceId: "host-led",
      operation: "set",
      payload: true,
      activeMs: 1000,
    });
    if (!grant.ok) throw new Error("expected an approval");
    expect(
      (
        await service.execute(
          request({ activeMs: 50_000, approvalToken: grant.token }),
        )
      ).detail,
    ).toMatch(/duration/);
  });
});
