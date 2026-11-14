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
    submit(kind: GateKind, nowMs: number, deadlineAtMs?: number): GateResult {
      return gate.submit(device, owner, generation, kind, nowMs, deadlineAtMs);
    },
    finish(ticket: number, nowMs: number): GateResult {
      return gate.finish(device, owner, generation, ticket, nowMs);
    },
    get generation(): number {
      return generation;
    },
  };
}

/**
 * Fake physical operation whose lifetime is independent of gate calls: it
 * ends only when the test ends it. Gate traffic alone never changes it,
 * so a test can hold an operation open past every lease and window.
 */
function operation() {
  let active = false;
  let completions = 0;
  return {
    begin() {
      active = true;
    },
    end() {
      if (active) {
        active = false;
        completions += 1;
      }
    },
    get running(): boolean {
      return active;
    },
    get ended(): number {
      return completions;
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

  it("renews explicitly, including after expiry, and rejects stale owners", () => {
    const gate = createResourceGate({
      leaseMs: 100,
      recoveryMs: 500,
      fence: () => true,
    });
    const a = driver(gate, "host-led", "worker-a");
    const b = driver(gate, "host-led", "worker-b");
    a.claim(0);
    expect(accepted(a.renew(50)).detail).toBe("renewed");
    // The lease now runs to 150, so the original expiry at 100 is covered.
    expect(refused(b.claim(120)).detail).toBe("device has a live owner");
    // Renewal still works after expiry while nobody replaced the owner.
    expect(accepted(a.renew(200)).detail).toBe("renewed");
    // Past the renewed lease plus the window, fenced recovery retires A.
    const recovered = accepted(b.recover(800));
    expect(recovered.generation).toBe(2);
    expect(recovered.abandoned).toBeUndefined();
    expect(refused(a.renew(810)).detail).toBe("stale owner");
    expect(refused(a.submit("actuate", 820)).detail).toBe("stale owner");
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

  it("refuses occupied recovery without fencing evidence", () => {
    const gate = createResourceGate({ leaseMs: 100, recoveryMs: 500 });
    const a = driver(gate, "host-led", "worker-a");
    const b = driver(gate, "host-led", "worker-b");
    const op = operation();
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    op.begin();
    // Worker A stops contacting the gate while its operation continues.
    expect(refused(b.claim(200)).detail).toBe("device is busy");
    expect(refused(b.recover(200)).detail).toBe("owner may still be active");
    // Past the window, silence still proves nothing: no second operation.
    expect(refused(b.recover(611)).detail).toBe("fencing required");
    expect(op.running).toBe(true);
    expect(refused(b.claim(620)).detail).toBe("device is busy");
    expect(refused(b.submit("actuate", 621)).detail).toBe("stale owner");
    // The old owner can still complete its own work.
    op.end();
    expect(accepted(a.finish(running.ticket ?? 0, 630)).detail).toBe("idle");
    expect(op.ended).toBe(1);
  });

  it("recovers an occupied device only on confirmed fencing", () => {
    let fenced = false;
    const fenceCalls: Array<{ device: string; nextGeneration: number }> = [];
    const gate = createResourceGate({
      leaseMs: 100,
      recoveryMs: 500,
      fence: (device, nextGeneration) => {
        fenceCalls.push({ device, nextGeneration });
        return fenced;
      },
    });
    const a = driver(gate, "host-led", "worker-a");
    const b = driver(gate, "host-led", "worker-b");
    const op = operation();
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    const queued = accepted(a.submit("read", 11));
    op.begin();
    // Worker A stops contacting the gate while its operation continues.
    // A refusing fence keeps the second operation out.
    expect(refused(b.recover(611)).detail).toBe("fencing refused");
    expect(op.running).toBe(true);
    expect(refused(b.submit("actuate", 612)).detail).toBe("stale owner");
    // Once fencing confirms the old worker stopped, recovery succeeds and
    // reports the abandoned ticket separately from the waiting one.
    op.end();
    fenced = true;
    const recovered = accepted(b.recover(613));
    expect(recovered.detail).toBe("recovered");
    expect(recovered.generation).toBe(2);
    expect(recovered.abandoned).toBe(running.ticket);
    expect(recovered.cancelled).toEqual([queued.ticket]);
    expect(fenceCalls).toEqual([
      { device: "host-led", nextGeneration: 2 },
      { device: "host-led", nextGeneration: 2 },
    ]);
    const next = accepted(b.submit("actuate", 620));
    expect(next.detail).toBe("started");
    // Old-owner messages cannot change the new operation.
    expect(refused(a.submit("actuate", 621)).detail).toBe("stale owner");
    expect(refused(a.finish(running.ticket ?? 0, 622)).detail).toBe(
      "stale owner",
    );
    expect(refused(a.finish(next.ticket ?? 0, 623)).detail).toBe("stale owner");
    expect(accepted(b.finish(next.ticket ?? 0, 630)).detail).toBe("idle");
    expect(op.ended).toBe(1);
  });

  it("fails occupied recovery closed when the fence throws", () => {
    const gate = createResourceGate({
      leaseMs: 100,
      recoveryMs: 500,
      fence: () => {
        throw new Error("fence unreachable");
      },
    });
    const a = driver(gate, "host-led", "worker-a");
    const b = driver(gate, "host-led", "worker-b");
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    expect(refused(b.recover(611)).detail).toBe("fencing failed");
    expect(refused(b.submit("actuate", 612)).detail).toBe("stale owner");
    // The failed attempt changed nothing: the old owner still owns it.
    expect(accepted(a.finish(running.ticket ?? 0, 620)).detail).toBe("idle");
  });

  it("recovers an idle device on the bounded path without a fence", () => {
    const gate = createResourceGate({ leaseMs: 100, recoveryMs: 500 });
    const a = driver(gate, "host-led", "worker-a");
    const b = driver(gate, "host-led", "worker-b");
    a.claim(0);
    const first = accepted(a.submit("actuate", 10));
    expect(accepted(a.finish(first.ticket ?? 0, 20)).detail).toBe("idle");
    // Worker A goes silent with nothing running.
    expect(refused(b.recover(200)).detail).toBe("owner may still be active");
    const recovered = accepted(b.recover(621));
    expect(recovered.detail).toBe("recovered");
    expect(recovered.generation).toBe(2);
    expect(recovered.abandoned).toBeUndefined();
    expect(accepted(b.submit("actuate", 630)).detail).toBe("started");
    expect(refused(a.submit("actuate", 640)).detail).toBe("stale owner");
  });

  it("reports abandoned work separately whether or not it dispatched", () => {
    for (const dispatched of [false, true]) {
      const gate = createResourceGate({
        leaseMs: 100,
        recoveryMs: 500,
        fence: () => true,
      });
      const a = driver(gate, "host-led", "worker-a");
      const b = driver(gate, "host-led", "worker-b");
      const op = operation();
      a.claim(0);
      const running = accepted(a.submit("actuate", 10));
      // In one pass the ticket was granted but never physically
      // dispatched; in the other the operation actually began.
      if (dispatched) op.begin();
      const waiting = accepted(a.submit("read", 11));
      const recovered = accepted(b.recover(611));
      expect(recovered.abandoned).toBe(running.ticket);
      expect(recovered.cancelled).toEqual([waiting.ticket]);
      expect(recovered.cancelled).not.toContain(running.ticket);
      op.end();
    }
  });

  it("rejects a restarted worker until fenced recovery retires its generation", () => {
    const gate = createResourceGate({
      leaseMs: 100,
      recoveryMs: 500,
      fence: () => true,
    });
    const a = driver(gate, "host-led", "worker-a");
    // A restart is a new incarnation, so it claims under a fresh ID:
    // reusing "worker-a" would renew generation 1 instead.
    const restarted = driver(gate, "host-led", "worker-a-restart-1");
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    // The old incarnation goes silent with work running.
    expect(refused(restarted.claim(700)).detail).toBe("device is busy");
    expect(refused(restarted.submit("stop", 701)).detail).toBe("stale owner");
    const recovered = accepted(restarted.recover(702));
    expect(recovered.generation).toBe(2);
    expect(recovered.abandoned).toBe(running.ticket);
    const next = accepted(restarted.submit("actuate", 710));
    expect(next.detail).toBe("started");
    expect(refused(a.finish(running.ticket ?? 0, 720)).detail).toBe(
      "stale owner",
    );
    expect(accepted(restarted.finish(next.ticket ?? 0, 730)).detail).toBe(
      "idle",
    );
  });

  it("reports a throwing policy check without losing queued work", () => {
    let throwing = false;
    const gate = createResourceGate({
      leaseMs: 1_000,
      policy: (_device, kind) => {
        if (throwing && kind === "actuate") {
          throw new Error("policy unreachable");
        }
        return { allowed: true };
      },
    });
    const a = driver(gate, "host-led", "worker-a");
    a.claim(0);
    const first = accepted(a.submit("actuate", 10));
    const expired = accepted(a.submit("read", 11, 15));
    const fragile = accepted(a.submit("actuate", 12));
    const queued = accepted(a.submit("read", 13));
    // The check starts throwing while B waits in the queue.
    throwing = true;
    const advanced = accepted(a.finish(first.ticket ?? 0, 20));
    // Nothing disappears: the expired wait and the throwing entry are
    // both reported, and the failure is flagged separately.
    expect(advanced.cancelled).toEqual([expired.ticket, fragile.ticket]);
    expect(advanced.policyFailures).toEqual([fragile.ticket]);
    expect(advanced.started).toBe(queued.ticket);
    // The gate stays usable once the check recovers.
    throwing = false;
    const drained = accepted(a.finish(queued.ticket ?? 0, 30));
    expect(drained.detail).toBe("idle");
    expect(drained.policyFailures).toBeUndefined();
    const again = accepted(a.submit("read", 40));
    expect(accepted(a.finish(again.ticket ?? 0, 50)).detail).toBe("idle");
  });

  it("refuses admission when the policy check throws, without losing state", () => {
    let throwing = true;
    const gate = createResourceGate({
      leaseMs: 1_000,
      policy: () => {
        if (throwing) throw new Error("policy unreachable");
        return { allowed: true };
      },
    });
    const a = driver(gate, "host-led", "worker-a");
    a.claim(0);
    expect(refused(a.submit("actuate", 10)).detail).toBe("policy check failed");
    expect(gate.depth("host-led")).toBe(0);
    throwing = false;
    const first = accepted(a.submit("actuate", 20));
    expect(accepted(a.finish(first.ticket ?? 0, 30)).detail).toBe("idle");
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
    expect(advanced.policyFailures).toBeUndefined();
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
    // The next submit reclaims the expired wait and reports it.
    const admitted = accepted(a.submit("read", 600));
    expect(admitted.cancelled).toEqual([stale.ticket]);
    expect(gate.depth("host-led")).toBe(2);
    const advanced = accepted(a.finish(running.ticket ?? 0, 700));
    expect(advanced.cancelled).toEqual([]);
    expect(advanced.started).toBe(later.ticket);
  });

  it("reclaims a queue of expired waits instead of refusing capacity", () => {
    const gate = createResourceGate({ leaseMs: 10_000, queueLimit: 2 });
    const a = driver(gate, "host-led", "worker-a");
    a.claim(0);
    const running = accepted(a.submit("actuate", 10));
    const first = accepted(a.submit("read", 20, 500));
    const second = accepted(a.submit("read", 30, 550));
    // A full queue of live waits still refuses without disturbing state.
    expect(refused(a.submit("read", 40)).detail).toBe("queue is full");
    expect(gate.depth("host-led")).toBe(2);
    // Once both waits expire behind the long-running operation, the next
    // submit reclaims them and is accepted.
    const admitted = accepted(a.submit("read", 600));
    expect(admitted.detail).toBe("queued");
    expect(admitted.cancelled).toEqual([first.ticket, second.ticket]);
    expect(gate.depth("host-led")).toBe(1);
    const advanced = accepted(a.finish(running.ticket ?? 0, 700));
    expect(advanced.started).toBe(admitted.ticket);
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

  it("leaves dispatch grants to the authoritative check while the ticket is held", () => {
    let hookCalls = 0;
    const gate = createResourceGate({
      leaseMs: 1_000,
      queueLimit: 1,
      policy: () => {
        hookCalls += 1;
        return { allowed: true };
      },
    });
    const a = driver(gate, "host-led", "worker-a");
    a.claim(0);
    let grants = 1;
    const effects: Array<number | undefined> = [];
    // The executor's authoritative per-request check with usage
    // accounting, run before the physical effect while the gate ticket
    // is held.
    function dispatch(ticket: number | undefined): boolean {
      if (ticket === undefined || grants < 1) return false;
      grants -= 1;
      effects.push(ticket);
      return true;
    }
    const first = accepted(a.submit("actuate", 10));
    const queued = accepted(a.submit("actuate", 11));
    // A capacity refusal never consults the hook and consumes no grant.
    expect(refused(a.submit("actuate", 12)).detail).toBe("queue is full");
    expect(hookCalls).toBe(2);
    expect(grants).toBe(1);
    // Admission alone runs no effect.
    expect(effects).toEqual([]);
    expect(dispatch(first.ticket)).toBe(true);
    const advanced = accepted(a.finish(first.ticket ?? 0, 20));
    expect(advanced.started).toBe(queued.ticket);
    // The hook ran at admission and again at dispatch: repeatable, with
    // no grant consumed either time.
    expect(hookCalls).toBe(3);
    expect(grants).toBe(0);
    expect(dispatch(queued.ticket)).toBe(false);
    expect(effects).toEqual([first.ticket]);
    accepted(a.finish(queued.ticket ?? 0, 30));
    // With no grant left, a selected request never runs its effect.
    const last = accepted(a.submit("actuate", 40));
    expect(dispatch(last.ticket)).toBe(false);
    expect(effects).toHaveLength(1);
    expect(accepted(a.finish(last.ticket ?? 0, 50)).detail).toBe("idle");
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
