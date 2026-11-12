/**
 * One owner per device, with a generation so a restarted worker cannot
 * keep using the old lease (issue #11). Stop requests bypass the queue.
 * The allowance counter moves in the same step as accepting the action.
 */
export type GateKind = "actuate" | "read" | "stop";

export interface GateResult {
  readonly accepted: boolean;
  readonly detail: string;
  readonly generation?: number;
}

interface Lease {
  ownerId: string;
  generation: number;
  expiresAtMs: number;
  inFlight: boolean;
}

interface Queued {
  readonly ownerId: string;
  readonly generation: number;
  readonly kind: GateKind;
}

export interface ResourceGate {
  claim(deviceId: string, ownerId: string, nowMs: number): GateResult;
  submit(
    deviceId: string,
    ownerId: string,
    generation: number,
    kind: GateKind,
    nowMs: number,
  ): GateResult;
  finish(
    deviceId: string,
    ownerId: string,
    generation: number,
    nowMs: number,
  ): GateResult;
  readonly depth: (deviceId: string) => number;
  readonly remaining: (deviceId: string) => number;
}

export function createResourceGate(
  options: {
    readonly leaseMs?: number;
    readonly queueLimit?: number;
    readonly allowance?: number;
  } = {},
): ResourceGate {
  const leaseMs = options.leaseMs ?? 1_000;
  const queueLimit = options.queueLimit ?? 4;
  const allowance = options.allowance ?? 2;
  const leases = new Map<string, Lease>();
  const queues = new Map<string, Queued[]>();
  const used = new Map<string, number>();

  function queueFor(deviceId: string): Queued[] {
    const existing = queues.get(deviceId);
    if (existing) return existing;
    const created: Queued[] = [];
    queues.set(deviceId, created);
    return created;
  }

  return {
    claim(deviceId, ownerId, nowMs) {
      const current = leases.get(deviceId);
      if (
        current &&
        current.expiresAtMs > nowMs &&
        current.ownerId !== ownerId
      ) {
        return { accepted: false, detail: "device has a live owner" };
      }
      const generation = (current?.generation ?? 0) + 1;
      leases.set(deviceId, {
        ownerId,
        generation,
        expiresAtMs: nowMs + leaseMs,
        inFlight: false,
      });
      return { accepted: true, detail: "claimed", generation };
    },
    submit(deviceId, ownerId, generation, kind, nowMs) {
      const lease = leases.get(deviceId);
      if (
        !lease ||
        lease.ownerId !== ownerId ||
        lease.generation !== generation
      ) {
        return { accepted: false, detail: "stale owner" };
      }
      if (lease.expiresAtMs <= nowMs) {
        return { accepted: false, detail: "owner lease expired" };
      }
      lease.expiresAtMs = nowMs + leaseMs;
      if (kind === "stop") {
        queueFor(deviceId).length = 0;
        lease.inFlight = false;
        return { accepted: true, detail: "stopped", generation };
      }
      const spent = used.get(deviceId) ?? 0;
      if (kind === "actuate" && spent >= allowance) {
        return { accepted: false, detail: "allowance exhausted" };
      }
      if (lease.inFlight) {
        const queue = queueFor(deviceId);
        if (queue.length >= queueLimit) {
          return { accepted: false, detail: "queue is full" };
        }
        queue.push({ ownerId, generation, kind });
        return { accepted: true, detail: "queued", generation };
      }
      lease.inFlight = true;
      if (kind === "actuate") used.set(deviceId, spent + 1);
      return { accepted: true, detail: "started", generation };
    },
    finish(deviceId, ownerId, generation, nowMs) {
      const lease = leases.get(deviceId);
      if (
        !lease ||
        lease.ownerId !== ownerId ||
        lease.generation !== generation
      ) {
        return { accepted: false, detail: "stale owner" };
      }
      lease.inFlight = false;
      const queue = queueFor(deviceId);
      const next = queue.shift();
      if (!next || next.generation !== generation) {
        return { accepted: true, detail: "idle", generation };
      }
      if (lease.expiresAtMs <= nowMs) {
        return { accepted: false, detail: "queued work expired" };
      }
      const spent = used.get(deviceId) ?? 0;
      if (next.kind === "actuate" && spent >= allowance) {
        return { accepted: false, detail: "allowance exhausted" };
      }
      lease.inFlight = true;
      if (next.kind === "actuate") used.set(deviceId, spent + 1);
      return { accepted: true, detail: "started", generation };
    },
    depth: (deviceId) => queueFor(deviceId).length,
    remaining: (deviceId) => allowance - (used.get(deviceId) ?? 0),
  };
}
