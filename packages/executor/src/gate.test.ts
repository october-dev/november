import { describe, expect, it } from "vitest";
import type {
  GateAccepted,
  GateKind,
  GateRejected,
  GateResult,
  ResourceGate,
} from "./gate.js";
import { createResourceGate } from "./gate.js";

function accepted(result: GateResult): GateAccepted {
  expect(result.accepted).toBe(true);
  return result as GateAccepted;
}

function refused(result: GateResult): GateRejected {
  expect(result.accepted).toBe(false);
  return result as GateRejected;
}

/**
 * Controllable fake worker: scripted claim/submit/finish sequences stand in
 * for an asynchronous device driver, so tests drive start, stop, and
 * completion ordering explicitly.
 */
function driver(gate: ResourceGate, device: string, owner: string) {
  let generation = 0;
  return {
    claim(nowMs: number): GateResult {
      const result = gate.claim(device, owner, nowMs);
      if (result.accepted) generation = result.generation;
      return result;
    },
    renew(nowMs: number): GateResult {
      return gate.renew(device, owner, generation, nowMs);
    },
    recover(nowMs: number): GateResult {
      const result = gate.recover(device, owner, nowMs);
      if (result.accepted) generation = result.generation;
      return result;
    },
    submit(kind: GateKind, nowMs: number, deadlineMs?: number): GateResult {
      return gate.submit(device, owner, generation, kind, nowMs, deadlineMs);
    },
    finish(ticket: number, nowMs: number): GateResult {
      return gate.finish(device, owner, generation, ticket, nowMs);
    },
    get generation(): number {
      return generation;
    },
  };
}

describe("resource gate", () => {
  it("gives one device a single owner and rejects a stale generation", () => {
    const gate = createResourceGate({ leaseMs: 100 });
    const a = driver(gate, "host-led", "worker-a");
    const b = driver(gate, "host-led", "worker-b");
    expect(accepted(a.claim(0)).generation).toBe(1);
    expect(refused(b.claim(10)).detail).toBe("device has a live owner");
    expect(accepted(b.claim(200)).generation).toBe(2);
    expect(refused(a.submit("actuate", 210)).detail).toBe("stale owner");
    expect(accepted(b.submit("actuate", 210)).detail).toBe("started");
  });

  it("ties completion to a ticket, so a duplicate finish cannot free the next command", () => {
    const gate = createResourceGate({ leaseMs: 1_000 });
    const a = driver(gate, "host-led", "worker-a");
    a.claim(0);
    const first = accepted(a.submit("actuate", 10));
    const second = accepted(a.submit("actuate", 11));
    expect(second.detail).toBe("queued");
    const advanced = accepted(a.finish(first.ticket ?? 0, 20));
    expect(advanced.started).toBe(second.ticket);
    expect(refused(a.finish(first.ticket ?? 0, 21)).detail).toBe(
      "unknown ticket",
    );
    // The next command is still running: new work queues behind it.
    expect(accepted(a.submit("read", 22)).detail).toBe("queued");
    expect(gate.depth("host-led")).toBe(1);
    const drained = accepted(a.finish(second.ticket ?? 0, 30));
    expect(drained.started).not.toBeUndefined();
    expect(accepted(a.finish(drained.started ?? 0, 40)).detail).toBe("idle");
  });

  it("keeps the device occupied after stop until the operation actually ends", () => {
    const gate = createResourceGate({ leaseMs: 1_000 });
    const a = driver(gate, "host-led", "worker-a");
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    const queued = accepted(a.submit("read", 11));
    expect(queued.detail).toBe("queued");
    const stop = accepted(a.submit("stop", 20));
    expect(stop.detail).toBe("stop pending");
    expect(stop.ticket).toBe(running.ticket);
    expect(stop.cancelled).toEqual([queued.ticket]);
    expect(gate.depth("host-led")).toBe(0);
    expect(refused(a.submit("read", 21)).detail).toBe("stop pending");
    expect(accepted(a.finish(running.ticket ?? 0, 30)).detail).toBe("stopped");
    expect(refused(a.finish(running.ticket ?? 0, 31)).detail).toBe(
      "unknown ticket",
    );
    const again = accepted(a.submit("read", 32));
    expect(again.detail).toBe("started");
    expect(accepted(a.finish(again.ticket ?? 0, 40)).detail).toBe("idle");
  });

  it("renews a live owner without resetting its running work", () => {
    const gate = createResourceGate({ leaseMs: 100 });
    const a = driver(gate, "host-led", "worker-a");
    const b = driver(gate, "host-led", "worker-b");
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    const renewed = accepted(a.claim(20));
    expect(renewed.detail).toBe("renewed");
    expect(renewed.generation).toBe(1);
    expect(accepted(a.finish(running.ticket ?? 0, 30)).detail).toBe("idle");
    expect(refused(b.claim(40)).detail).toBe("device has a live owner");
    expect(accepted(b.claim(2_000)).generation).toBe(2);
  });

  it("refuses takeover of a running operation but keeps stop available after expiry", () => {
    const gate = createResourceGate({ leaseMs: 100 });
    const a = driver(gate, "host-led", "worker-a");
    const b = driver(gate, "host-led", "worker-b");
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    expect(refused(b.claim(200)).detail).toBe("device is busy");
    expect(refused(b.submit("stop", 210)).detail).toBe("stale owner");
    const stop = accepted(a.submit("stop", 250));
    expect(stop.detail).toBe("stop pending");
    expect(accepted(a.finish(running.ticket ?? 0, 260)).detail).toBe("stopped");
  });

  it("recovers a dead owner's device only through the bounded path", () => {
    const gate = createResourceGate({ leaseMs: 100, recoveryMs: 500 });
    const a = driver(gate, "host-led", "worker-a");
    const b = driver(gate, "host-led", "worker-b");
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    const queued = accepted(a.submit("read", 11));
    // Worker A dies here: no more calls from it.
    expect(refused(b.claim(200)).detail).toBe("device is busy");
    expect(refused(b.recover(200)).detail).toBe("owner may still be active");
    const recovered = accepted(b.recover(611));
    expect(recovered.detail).toBe("recovered");
    expect(recovered.generation).toBe(2);
    expect(recovered.cancelled).toEqual([running.ticket, queued.ticket]);
    const next = accepted(b.submit("actuate", 620));
    expect(next.detail).toBe("started");
    expect(accepted(b.finish(next.ticket ?? 0, 630)).detail).toBe("idle");
    expect(refused(a.submit("actuate", 640)).detail).toBe("stale owner");
  });

  it("consults fencing before recovery when a fence is configured", () => {
    let fenced = false;
    const gate = createResourceGate({
      leaseMs: 100,
      recoveryMs: 500,
      fence: () => fenced,
    });
    const a = driver(gate, "host-led", "worker-a");
    const b = driver(gate, "host-led", "worker-b");
    a.claim(0);
    a.submit("actuate", 10);
    expect(refused(b.recover(611)).detail).toBe("fencing refused");
    fenced = true;
    expect(accepted(b.recover(612)).detail).toBe("recovered");
  });

  it("skips a refused queued entry and drains the rest exactly once", () => {
    let actuations = 0;
    const gate = createResourceGate({
      leaseMs: 1_000,
      policy: (_device, kind) =>
        kind === "actuate" && actuations > 0
          ? { allowed: false, reason: "frozen" }
          : { allowed: true },
    });
    const a = driver(gate, "host-led", "worker-a");
    a.claim(0);
    const first = accepted(a.submit("actuate", 10));
    const frozen = accepted(a.submit("actuate", 11));
    const readable = accepted(a.submit("read", 12));
    // Policy state changes while the actuation waits in the queue.
    actuations += 1;
    const advanced = accepted(a.finish(first.ticket ?? 0, 20));
    expect(advanced.cancelled).toEqual([frozen.ticket]);
    expect(advanced.started).toBe(readable.ticket);
    const drained = accepted(a.finish(readable.ticket ?? 0, 30));
    expect(drained.detail).toBe("idle");
    expect(drained.cancelled).toEqual([]);
    expect(gate.depth("host-led")).toBe(0);
  });

  it("expires queued work by its own deadline while the lease stays alive", () => {
    const gate = createResourceGate({ leaseMs: 1_000 });
    const a = driver(gate, "host-led", "worker-a");
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    const stale = accepted(a.submit("read", 20, 500));
    const later = accepted(a.submit("read", 300));
    accepted(a.submit("read", 600));
    const advanced = accepted(a.finish(running.ticket ?? 0, 700));
    expect(advanced.cancelled).toEqual([stale.ticket]);
    expect(advanced.started).toBe(later.ticket);
  });

  it("does not renew the lease on a rejected full-queue submit", () => {
    const gate = createResourceGate({ leaseMs: 1_000, queueLimit: 1 });
    const a = driver(gate, "host-led", "worker-a");
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    const queued = accepted(a.submit("read", 11, 2_000));
    expect(refused(a.submit("read", 12)).detail).toBe("queue is full");
    expect(refused(a.submit("read", 1_012)).detail).toBe("owner lease expired");
    // Completion still reports after expiry and renews the lease.
    const advanced = accepted(a.finish(running.ticket ?? 0, 1_020));
    expect(advanced.started).toBe(queued.ticket);
    expect(accepted(a.submit("read", 1_030)).detail).toBe("queued");
  });

  it("checks policy at dispatch, not just at admission", () => {
    let allowed = true;
    const gate = createResourceGate({
      leaseMs: 1_000,
      policy: () =>
        allowed ? { allowed: true } : { allowed: false, reason: "frozen" },
    });
    const a = driver(gate, "host-led", "worker-a");
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    const queued = accepted(a.submit("read", 11));
    allowed = false;
    const advanced = accepted(a.finish(running.ticket ?? 0, 20));
    expect(advanced.cancelled).toEqual([queued.ticket]);
    expect(advanced.detail).toBe("idle");
    expect(refused(a.submit("read", 30)).detail).toBe("policy denied: frozen");
    allowed = true;
    const again = accepted(a.submit("read", 40));
    expect(accepted(a.finish(again.ticket ?? 0, 50)).detail).toBe("idle");
  });

  it("validates time, deadlines, kinds, devices, and options", () => {
    const gate = createResourceGate({ leaseMs: 100 });
    const a = driver(gate, "host-led", "worker-a");
    expect(refused(gate.claim("host-led", "worker-a", Number.NaN)).detail).toBe(
      "invalid time",
    );
    expect(refused(a.submit("actuate", 0)).detail).toBe("unknown device");
    expect(refused(a.renew(0)).detail).toBe("unknown device");
    expect(refused(a.recover(0)).detail).toBe("unknown device");
    expect(gate.depth("host-led")).toBe(0);
    a.claim(0);
    expect(refused(a.submit("actuate", 10, 10)).detail).toBe(
      "invalid deadline",
    );
    expect(refused(a.submit("actuate", 10, Number.NaN)).detail).toBe(
      "invalid deadline",
    );
    expect(refused(a.submit("explode" as unknown as GateKind, 10)).detail).toBe(
      "unknown kind",
    );
    expect(refused(a.finish(1, Number.NaN)).detail).toBe("invalid time");
    expect(refused(a.recover(50)).detail).toBe("owner may still be active");
    expect(() => createResourceGate({ leaseMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => createResourceGate({ queueLimit: -1 })).toThrow(RangeError);
    expect(() => createResourceGate({ maxWaitMs: 0 })).toThrow(RangeError);
  });
});
