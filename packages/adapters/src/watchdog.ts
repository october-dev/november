/**
 * Simulated protective deadlines for the reference outputs (issue #14).
 *
 * This is a host-side simulation model for tests, not a hardware driver: the
 * caller supplies a monotonic clock and drives every transition explicitly,
 * so wall-clock changes are invisible.
 *
 * Admission rule: a command is accepted only while armed, only when the
 * output is off, and only when a heartbeat arrived within the last
 * HEARTBEAT_CUTOFF_MS (2s). A rejected command never changes the output,
 * the deadline, or the remembered command history.
 *
 * The Pico LED turns off by itself at its deadline (normal completion, stays
 * armed) and within 2s of the last heartbeat. Heartbeat loss means the host
 * may be gone, so that cutoff also disarms: an interrupted action resumes
 * only after an explicit re-arm. A duplicate command, a heartbeat, or a
 * fresh command id can never extend or move a running deadline.
 * Non-finite timestamps fail toward off and are never stored.
 * A new instance starts off and disarmed.
 */
export const PICO_MAX_ACTIVE_MS = 30_000;
export const PICO_DEFAULT_ACTIVE_MS = 2_000;
export const HEARTBEAT_CUTOFF_MS = 2_000;

export interface CommandResult {
  readonly accepted: boolean;
  readonly detail: string;
  readonly activeMs?: number;
}

export interface ProtectedLed {
  readonly armed: boolean;
  readonly on: boolean;
  arm(): void;
  disarm(): void;
  command(
    id: string,
    requestedMs: number | undefined,
    nowMs: number,
  ): CommandResult;
  heartbeat(nowMs: number): void;
  tick(nowMs: number): void;
}

export function createPicoLed(): ProtectedLed {
  let armed = false;
  let on = false;
  let deadlineMs: number | undefined;
  let lastHeartbeatMs: number | undefined;
  const seen = new Set<string>();

  function cut(): void {
    on = false;
    deadlineMs = undefined;
  }

  // Settle any elapsed deadline or heartbeat cutoff at the caller's time.
  // Duration expiry is normal completion and stays armed; heartbeat loss
  // interrupts the action, so it also disarms until explicitly re-armed.
  function settle(nowMs: number): void {
    if (!on || deadlineMs === undefined) return;
    if (nowMs >= deadlineMs) {
      cut();
      return;
    }
    if (
      lastHeartbeatMs !== undefined &&
      nowMs - lastHeartbeatMs >= HEARTBEAT_CUTOFF_MS
    ) {
      cut();
      armed = false;
    }
  }

  return {
    get armed() {
      return armed;
    },
    get on() {
      return on;
    },
    arm() {
      if (armed) return;
      armed = true;
    },
    disarm() {
      armed = false;
      lastHeartbeatMs = undefined;
      cut();
    },
    command(id, requestedMs, nowMs) {
      if (!armed) return { accepted: false, detail: "disarmed" };
      if (!Number.isFinite(nowMs))
        return { accepted: false, detail: "time must be finite" };
      const activeMs = requestedMs ?? PICO_DEFAULT_ACTIVE_MS;
      if (
        !Number.isInteger(activeMs) ||
        activeMs < 1 ||
        activeMs > PICO_MAX_ACTIVE_MS
      ) {
        return { accepted: false, detail: "duration is outside 1 to 30000 ms" };
      }
      settle(nowMs);
      if (seen.has(id))
        return {
          accepted: false,
          detail: "duplicate command cannot extend the deadline",
        };
      if (on) return { accepted: false, detail: "output is already on" };
      if (
        lastHeartbeatMs === undefined ||
        nowMs - lastHeartbeatMs >= HEARTBEAT_CUTOFF_MS
      ) {
        return {
          accepted: false,
          detail:
            lastHeartbeatMs === undefined
              ? "no heartbeat received since arming"
              : "heartbeat is older than 2s",
        };
      }
      seen.add(id);
      on = true;
      deadlineMs = nowMs + activeMs;
      return { accepted: true, detail: "on", activeMs };
    },
    heartbeat(nowMs) {
      if (!armed) return;
      if (!Number.isFinite(nowMs)) return;
      lastHeartbeatMs = nowMs;
    },
    tick(nowMs) {
      if (!Number.isFinite(nowMs)) {
        cut();
        return;
      }
      settle(nowMs);
    },
  };
}

/** Host diagnostic LED: either state is allowed indefinitely. Shutdown requests off. */
export function createHostLed(): {
  readonly on: boolean;
  set(on: boolean): void;
  shutdown(): void;
} {
  let on = false;
  return {
    get on() {
      return on;
    },
    set(next) {
      on = next;
    },
    shutdown() {
      on = false;
    },
  };
}
