/**
 * Protective deadlines for the reference outputs (issue #14).
 *
 * Time is the caller's monotonic clock. Wall-clock changes are invisible.
 * The Pico LED turns off by itself at its deadline and within 2s of the last
 * heartbeat. A duplicate command or a heartbeat cannot extend that deadline.
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

  return {
    get armed() {
      return armed;
    },
    get on() {
      return on;
    },
    arm() {
      armed = true;
      lastHeartbeatMs = undefined;
    },
    disarm() {
      armed = false;
      cut();
    },
    command(id, requestedMs, nowMs) {
      if (!armed) return { accepted: false, detail: "disarmed" };
      const activeMs = requestedMs ?? PICO_DEFAULT_ACTIVE_MS;
      if (
        !Number.isInteger(activeMs) ||
        activeMs < 1 ||
        activeMs > PICO_MAX_ACTIVE_MS
      ) {
        return { accepted: false, detail: "duration is outside 1 to 30000 ms" };
      }
      if (seen.has(id))
        return {
          accepted: false,
          detail: "duplicate command cannot extend the deadline",
        };
      seen.add(id);
      on = true;
      deadlineMs = nowMs + activeMs;
      if (lastHeartbeatMs === undefined) lastHeartbeatMs = nowMs;
      return { accepted: true, detail: "on", activeMs };
    },
    heartbeat(nowMs) {
      if (!armed) return;
      lastHeartbeatMs = nowMs;
    },
    tick(nowMs) {
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
      }
    },
  };
}

/** Host diagnostic LED: either state is allowed indefinitely. Shutdown requests off. */
export function createHostLed(): {
  on: boolean;
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
