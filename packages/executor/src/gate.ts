/**
 * One owner per device, with serialization of that owner's work (issue #11).
 *
 * Time is caller-supplied monotonic milliseconds. Production must pass a
 * trusted monotonic source; callers that move time backwards can shorten
 * leases, and callers that jump forward can force takeovers. Non-finite
 * timestamps are rejected without changing state.
 *
 * Ownership: claim() sets the owner. The same owner claiming again while
 * its lease is live renews it; a different owner is rejected until the
 * lease lapses. A claim never interrupts a running operation: while work
 * is marked running, even an expired lease cannot be claimed. Taking over
 * a device whose owner died mid-operation requires recover(), which waits
 * for a bounded inactivity window past lease expiry and consults the
 * optional fencing hook. Pair this with device-side fencing at
 * integration; the hook defaults to time-based inactivity only.
 *
 * Work items: every accepted submit() returns a ticket. finish() must
 * name the running ticket, so a duplicate or late completion can never
 * release another command. Each request carries its own immutable
 * deadline; owner renewals never extend a queued request's wait, and
 * expired requests are skipped at dispatch and reported as cancelled.
 * The gate enforces only the per-device queue limit here; overall
 * pending-action caps, byte accounting, and rejection counters belong to
 * the integrated dispatch path.
 *
 * Policy: the caller supplies a check that runs at the moment an action
 * actually starts, both for direct starts and for work leaving the queue.
 * The gate implements no policy rules of its own.
 *
 * Stop: a stop request from the current owner clears queued work but keeps
 * the running operation occupied until its completion arrives or a
 * verified recovery makes reuse safe. Stop stays available after the
 * execution lease expires; requesting cancellation is never completion.
 *
 * Generations restart at 1 per gate instance, so a gate instance must
 * live as long as its owners and their delayed messages.
 */
export type GateKind = "actuate" | "read" | "stop";

export type GateAccepted = {
  readonly accepted: true;
  readonly detail: string;
  readonly generation: number;
  /** Ticket issued or acted on by this call, when there is one. */
  readonly ticket?: number;
  /** Queued ticket that started because of this call, when there is one. */
  readonly started?: number;
  /** Tickets dropped by this call, oldest first. */
  readonly cancelled?: readonly number[];
};

export type GateRejected = {
  readonly accepted: false;
  readonly detail: string;
  readonly generation?: undefined;
  readonly ticket?: undefined;
  readonly started?: undefined;
  readonly cancelled?: undefined;
};

export type GateResult = GateAccepted | GateRejected;

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

interface Lease {
  ownerId: string;
  generation: number;
  expiresAtMs: number;
  /** Ticket of the running operation, or undefined when idle. */
  running?: number;
  stopPending: boolean;
  nextTicket: number;
}

interface Queued {
  readonly ticket: number;
  readonly kind: Exclude<GateKind, "stop">;
  readonly deadlineMs: number;
}

export interface ResourceGate {
  claim(deviceId: string, ownerId: string, nowMs: number): GateResult;
  renew(
    deviceId: string,
    ownerId: string,
    generation: number,
    nowMs: number,
  ): GateResult;
  recover(deviceId: string, ownerId: string, nowMs: number): GateResult;
  submit(
    deviceId: string,
    ownerId: string,
    generation: number,
    kind: GateKind,
    nowMs: number,
    deadlineMs?: number,
  ): GateResult;
  finish(
    deviceId: string,
    ownerId: string,
    generation: number,
    ticket: number,
    nowMs: number,
  ): GateResult;
  readonly depth: (deviceId: string) => number;
}

function rejected(detail: string): GateRejected {
  return { accepted: false, detail };
}

export function createResourceGate(
  options: {
    readonly leaseMs?: number;
    readonly queueLimit?: number;
    /** Default wait deadline for a request, measured from admission. */
    readonly maxWaitMs?: number;
    /** Extra inactivity past lease expiry before recover() may take over. */
    readonly recoveryMs?: number;
    /** Runs at the moment an action actually starts. */
    readonly policy?: (
      deviceId: string,
      kind: Exclude<GateKind, "stop">,
      nowMs: number,
    ) => PolicyDecision;
    /**
     * Confirms the previous worker is stopped before recover() takes over.
     * When absent, recovery relies on the bounded inactivity window alone.
     */
    readonly fence?: (deviceId: string) => boolean;
  } = {},
): ResourceGate {
  const leaseMs = options.leaseMs ?? 1_000;
  const queueLimit = options.queueLimit ?? 4;
  const maxWaitMs = options.maxWaitMs ?? 1_000;
  const recoveryMs = options.recoveryMs ?? leaseMs;
  for (const [name, value, integer] of [
    ["leaseMs", leaseMs, false],
    ["queueLimit", queueLimit, true],
    ["maxWaitMs", maxWaitMs, false],
    ["recoveryMs", recoveryMs, false],
  ] as const) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (integer && !Number.isInteger(value))
    ) {
      throw new RangeError(`${name} must be a finite number >= 0`);
    }
  }
  if (leaseMs < 1 || maxWaitMs < 1 || recoveryMs < 1) {
    throw new RangeError("leaseMs, maxWaitMs, and recoveryMs must be >= 1");
  }
  const policy = options.policy ?? (() => ({ allowed: true }));
  const fence = options.fence;

  const leases = new Map<string, Lease>();
  const queues = new Map<string, Queued[]>();

  function queueFor(deviceId: string): Queued[] {
    const existing = queues.get(deviceId);
    if (existing) return existing;
    const created: Queued[] = [];
    queues.set(deviceId, created);
    return created;
  }

  function liveOwner(
    lease: Lease,
    ownerId: string,
    generation: number,
  ): boolean {
    return lease.ownerId === ownerId && lease.generation === generation;
  }

  // Start queued work after a completion: skip expired entries, re-check
  // policy per entry, and report every dropped ticket to the caller.
  function dispatch(
    deviceId: string,
    lease: Lease,
    nowMs: number,
  ): { started?: number; cancelled: number[] } {
    const queue = queueFor(deviceId);
    const cancelled: number[] = [];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      if (next.deadlineMs <= nowMs) {
        cancelled.push(next.ticket);
        continue;
      }
      const decision = policy(deviceId, next.kind, nowMs);
      if (!decision.allowed) {
        cancelled.push(next.ticket);
        continue;
      }
      lease.running = next.ticket;
      return { started: next.ticket, cancelled };
    }
    return { cancelled };
  }

  return {
    claim(deviceId, ownerId, nowMs) {
      if (!Number.isFinite(nowMs)) return rejected("invalid time");
      const current = leases.get(deviceId);
      if (!current) {
        leases.set(deviceId, {
          ownerId,
          generation: 1,
          expiresAtMs: nowMs + leaseMs,
          running: undefined,
          stopPending: false,
          nextTicket: 1,
        });
        return { accepted: true, detail: "claimed", generation: 1 };
      }
      if (current.expiresAtMs > nowMs) {
        if (current.ownerId !== ownerId) {
          return rejected("device has a live owner");
        }
        // Same owner while live: safe renewal, never a reset.
        current.expiresAtMs = nowMs + leaseMs;
        return {
          accepted: true,
          detail: "renewed",
          generation: current.generation,
        };
      }
      if (current.running !== undefined) {
        // Expiry alone cannot prove the old worker stopped.
        return rejected("device is busy");
      }
      // A takeover requires an idle device, and finish() drains the queue
      // atomically, so this is normally empty; clear defensively so no
      // previous-generation wait can survive a transition.
      const cancelled = queueFor(deviceId).map((entry) => entry.ticket);
      queueFor(deviceId).length = 0;
      const generation = current.generation + 1;
      leases.set(deviceId, {
        ownerId,
        generation,
        expiresAtMs: nowMs + leaseMs,
        running: undefined,
        stopPending: false,
        nextTicket: current.nextTicket,
      });
      return { accepted: true, detail: "claimed", generation, cancelled };
    },

    renew(deviceId, ownerId, generation, nowMs) {
      if (!Number.isFinite(nowMs)) return rejected("invalid time");
      const lease = leases.get(deviceId);
      if (!lease) return rejected("unknown device");
      if (!liveOwner(lease, ownerId, generation)) {
        return rejected("stale owner");
      }
      lease.expiresAtMs = nowMs + leaseMs;
      return { accepted: true, detail: "renewed", generation };
    },

    recover(deviceId, ownerId, nowMs) {
      if (!Number.isFinite(nowMs)) return rejected("invalid time");
      const lease = leases.get(deviceId);
      if (!lease) return rejected("unknown device");
      if (lease.expiresAtMs + recoveryMs > nowMs) {
        return rejected("owner may still be active");
      }
      if (fence && !fence(deviceId)) {
        return rejected("fencing refused");
      }
      const cancelled: number[] = [];
      if (lease.running !== undefined) cancelled.push(lease.running);
      for (const entry of queueFor(deviceId)) cancelled.push(entry.ticket);
      queueFor(deviceId).length = 0;
      const generation = lease.generation + 1;
      leases.set(deviceId, {
        ownerId,
        generation,
        expiresAtMs: nowMs + leaseMs,
        running: undefined,
        stopPending: false,
        nextTicket: lease.nextTicket,
      });
      return { accepted: true, detail: "recovered", generation, cancelled };
    },

    submit(deviceId, ownerId, generation, kind, nowMs, deadlineMs) {
      if (!Number.isFinite(nowMs)) return rejected("invalid time");
      const lease = leases.get(deviceId);
      if (!lease) return rejected("unknown device");
      if (!liveOwner(lease, ownerId, generation)) {
        return rejected("stale owner");
      }
      if (kind !== "actuate" && kind !== "read" && kind !== "stop") {
        return rejected("unknown kind");
      }
      if (kind === "stop") {
        // The authorized stop path ignores lease expiry.
        const cancelled = queueFor(deviceId).map((entry) => entry.ticket);
        queueFor(deviceId).length = 0;
        lease.expiresAtMs = nowMs + leaseMs;
        if (lease.running === undefined) {
          return { accepted: true, detail: "stopped", generation, cancelled };
        }
        lease.stopPending = true;
        return {
          accepted: true,
          detail: "stop pending",
          generation,
          ticket: lease.running,
          cancelled,
        };
      }
      if (lease.expiresAtMs <= nowMs) {
        return rejected("owner lease expired");
      }
      if (lease.stopPending) {
        return rejected("stop pending");
      }
      const deadline = deadlineMs ?? nowMs + maxWaitMs;
      if (!Number.isFinite(deadline) || deadline <= nowMs) {
        return rejected("invalid deadline");
      }
      const decision = policy(deviceId, kind, nowMs);
      if (!decision.allowed) {
        return rejected(
          decision.reason
            ? `policy denied: ${decision.reason}`
            : "policy denied",
        );
      }
      if (lease.running !== undefined) {
        const queue = queueFor(deviceId);
        if (queue.length >= queueLimit) {
          return rejected("queue is full");
        }
        const ticket = lease.nextTicket;
        lease.nextTicket += 1;
        queue.push({ ticket, kind, deadlineMs: deadline });
        lease.expiresAtMs = nowMs + leaseMs;
        return { accepted: true, detail: "queued", generation, ticket };
      }
      const ticket = lease.nextTicket;
      lease.nextTicket += 1;
      lease.running = ticket;
      lease.expiresAtMs = nowMs + leaseMs;
      return { accepted: true, detail: "started", generation, ticket };
    },

    finish(deviceId, ownerId, generation, ticket, nowMs) {
      if (!Number.isFinite(nowMs)) return rejected("invalid time");
      const lease = leases.get(deviceId);
      if (!lease) return rejected("unknown device");
      if (!liveOwner(lease, ownerId, generation)) {
        return rejected("stale owner");
      }
      if (lease.running === undefined || lease.running !== ticket) {
        return rejected("unknown ticket");
      }
      lease.running = undefined;
      lease.expiresAtMs = nowMs + leaseMs;
      if (lease.stopPending) {
        lease.stopPending = false;
        return {
          accepted: true,
          detail: "stopped",
          generation,
          ticket,
          cancelled: [],
        };
      }
      const { started, cancelled } = dispatch(deviceId, lease, nowMs);
      if (started === undefined) {
        return {
          accepted: true,
          detail: "idle",
          generation,
          ticket,
          cancelled,
        };
      }
      return {
        accepted: true,
        detail: "started",
        generation,
        ticket,
        started,
        cancelled,
      };
    },

    depth: (deviceId) => queues.get(deviceId)?.length ?? 0,
  };
}
