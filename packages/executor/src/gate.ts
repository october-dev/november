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
 * lease lapses. An owner ID names one worker incarnation: a restarted
 * worker MUST claim under a fresh ID. Reusing the previous incarnation's
 * ID renews the old generation and hands the restarted worker the old
 * generation, the running ticket via stop(), and the power to finish()
 * it — bypassing recovery evidence entirely. Generations reject stale
 * workers only when each incarnation uses its own ID.
 *
 * Recovery: recover() answers promptly and succeeds once reuse is proven
 * safe; it returns a refusal (never silence) when it cannot prove that.
 * For an occupied device, silence is never evidence: recovery requires
 * the fencing hook to confirm the old owner stopped, after a bounded
 * inactivity window past lease expiry. Without a configured fence,
 * occupied recovery is refused. Takeover of an idle device after expiry
 * needs no fence: the old owner holds no running ticket and its
 * generation no longer gets one.
 *
 * The running ticket abandoned by recover() is returned separately in
 * `abandoned`, never mixed into `cancelled`. Abandoned work may or may
 * not have reached physical dispatch — submit() marks a ticket running
 * before any caller/device work executes — so the action log and executor
 * must establish its outcome from journal evidence, and must never
 * auto-retry while that outcome is uncertain. `cancelled` holds only
 * waits that never acquired the device.
 *
 * Work items: every accepted submit() returns a ticket. finish() must
 * name the running ticket, so a duplicate or late completion can never
 * release another command. Each request carries its own immutable
 * absolute latest-start instant (`deadlineAtMs`); owner renewals never
 * extend a queued request's wait. Convert that instant from the original
 * admission time plus the admission budget on the same monotonic clock,
 * and never reset it when work moves between components: it bounds when
 * work may start, not when it must complete. Expired waits are reclaimed
 * on the next accepted submit() and reported in its `cancelled` list, or
 * skipped at dispatch; a refusal never reclaims, so no ticket disappears
 * without a report. The gate enforces only the per-device queue limit
 * here; overall pending-action caps, byte accounting, and rejection
 * counters belong to the integrated dispatch path.
 *
 * Policy: the caller supplies a pure eligibility predicate. It must be
 * repeatable and side-effect free: the gate calls it at admission and
 * again each time a queued request is considered at dispatch, and it may
 * be called for requests that never run. It must never consume a grant or
 * perform accounting. Authoritative per-request checks and usage
 * accounting run in the executor before the physical effect, while the
 * gate ticket is held. A capacity refusal never consults the hook. A
 * throwing hook fails closed: at admission the submit is refused, and at
 * dispatch the entry is dropped, reported in `cancelled` and
 * `policyFailures`, while the rest of the queue keeps working.
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
  /**
   * Running ticket abandoned by recover(), when the device was occupied.
   * It may or may not have reached physical dispatch; reconcile its
   * outcome from journal evidence, never from this field alone.
   */
  readonly abandoned?: number;
  /**
   * Tickets dropped because the policy hook threw, oldest first. Every
   * entry here also appears in `cancelled`.
   */
  readonly policyFailures?: readonly number[];
};

export type GateRejected = {
  readonly accepted: false;
  readonly detail: string;
  readonly generation?: undefined;
  readonly ticket?: undefined;
  readonly started?: undefined;
  readonly cancelled?: undefined;
  readonly abandoned?: undefined;
  readonly policyFailures?: undefined;
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
  /** Absolute latest-start instant on the caller's monotonic clock. */
  readonly deadlineAtMs: number;
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
    deadlineAtMs?: number,
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
    /** Default wait budget for a request, measured from admission. */
    readonly maxWaitMs?: number;
    /** Extra inactivity past lease expiry before recover() may take over. */
    readonly recoveryMs?: number;
    /**
     * Pure eligibility predicate. Must be repeatable and side-effect
     * free: it runs at admission and again at each dispatch
     * consideration, including for requests that never run. Never
     * consume a grant here; the executor performs authoritative checks
     * and accounting before the physical effect while holding the
     * ticket. A throw fails closed (refusal at admission, drop with a
     * report at dispatch).
     */
    readonly policy?: (
      deviceId: string,
      kind: Exclude<GateKind, "stop">,
      nowMs: number,
    ) => PolicyDecision;
    /**
     * Confirms the previous worker stopped before recover() takes over
     * an occupied device. Receives the device and the generation the
     * recovery would install, so device-side fencing can target it.
     * Occupied recovery without a configured fence is refused; a
     * refusal or a throw fails closed. Idle takeover consults it only
     * when one is configured.
     */
    readonly fence?: (deviceId: string, nextGeneration: number) => boolean;
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
  // policy per entry, and report every dropped ticket to the caller. A
  // throwing policy check drops only its own entry; the rest of the
  // queue keeps working and earlier reports are preserved.
  function dispatch(
    deviceId: string,
    lease: Lease,
    nowMs: number,
  ): { started?: number; cancelled: number[]; policyFailures: number[] } {
    const queue = queueFor(deviceId);
    const cancelled: number[] = [];
    const policyFailures: number[] = [];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      if (next.deadlineAtMs <= nowMs) {
        cancelled.push(next.ticket);
        continue;
      }
      let decision: PolicyDecision;
      try {
        decision = policy(deviceId, next.kind, nowMs);
      } catch {
        cancelled.push(next.ticket);
        policyFailures.push(next.ticket);
        continue;
      }
      if (!decision.allowed) {
        cancelled.push(next.ticket);
        continue;
      }
      lease.running = next.ticket;
      return { started: next.ticket, cancelled, policyFailures };
    }
    return { cancelled, policyFailures };
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
        // Same owner while live: safe renewal, never a reset. This is
        // why each worker incarnation needs a fresh ID: a restarted
        // worker reusing its old ID would renew this generation instead
        // of proving recovery safe.
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
      if (lease.running !== undefined && !fence) {
        // Occupied and unfenced: silence is not evidence that the old
        // operation ended, so reuse cannot be proven safe.
        return rejected("fencing required");
      }
      if (fence) {
        let confirmed: boolean;
        try {
          confirmed = fence(deviceId, lease.generation + 1);
        } catch {
          return rejected("fencing failed");
        }
        if (!confirmed) {
          return rejected("fencing refused");
        }
      }
      const abandoned = lease.running;
      const cancelled: number[] = [];
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
      if (abandoned === undefined) {
        return { accepted: true, detail: "recovered", generation, cancelled };
      }
      return {
        accepted: true,
        detail: "recovered",
        generation,
        abandoned,
        cancelled,
      };
    },

    submit(deviceId, ownerId, generation, kind, nowMs, deadlineAtMs) {
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
      const deadline = deadlineAtMs ?? nowMs + maxWaitMs;
      if (!Number.isFinite(deadline) || deadline <= nowMs) {
        return rejected("invalid deadline");
      }
      if (lease.running !== undefined) {
        const queue = queueFor(deviceId);
        // Reclaim expired waits before the capacity check so a
        // long-running operation cannot pin dead entries in a full
        // queue. The prune commits only as part of an accepted submit;
        // a refused submit leaves the queue untouched, so no ticket
        // disappears without a report.
        const live = queue.filter((entry) => entry.deadlineAtMs > nowMs);
        if (live.length >= queueLimit) {
          return rejected("queue is full");
        }
        let decision: PolicyDecision;
        try {
          decision = policy(deviceId, kind, nowMs);
        } catch {
          return rejected("policy check failed");
        }
        if (!decision.allowed) {
          return rejected(
            decision.reason
              ? `policy denied: ${decision.reason}`
              : "policy denied",
          );
        }
        const cancelled = queue
          .filter((entry) => entry.deadlineAtMs <= nowMs)
          .map((entry) => entry.ticket);
        queue.length = 0;
        queue.push(...live);
        const ticket = lease.nextTicket;
        lease.nextTicket += 1;
        queue.push({ ticket, kind, deadlineAtMs: deadline });
        lease.expiresAtMs = nowMs + leaseMs;
        if (cancelled.length === 0) {
          return { accepted: true, detail: "queued", generation, ticket };
        }
        return {
          accepted: true,
          detail: "queued",
          generation,
          ticket,
          cancelled,
        };
      }
      let decision: PolicyDecision;
      try {
        decision = policy(deviceId, kind, nowMs);
      } catch {
        return rejected("policy check failed");
      }
      if (!decision.allowed) {
        return rejected(
          decision.reason
            ? `policy denied: ${decision.reason}`
            : "policy denied",
        );
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
      const { started, cancelled, policyFailures } = dispatch(
        deviceId,
        lease,
        nowMs,
      );
      if (started === undefined) {
        if (policyFailures.length === 0) {
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
          detail: "idle",
          generation,
          ticket,
          cancelled,
          policyFailures,
        };
      }
      if (policyFailures.length === 0) {
        return {
          accepted: true,
          detail: "started",
          generation,
          ticket,
          started,
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
        policyFailures,
      };
    },

    depth: (deviceId) => queues.get(deviceId)?.length ?? 0,
  };
}
