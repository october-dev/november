/**
 * Deterministic device simulator and failure rig (issue #7).
 *
 * The clock and the seed decide every reading, deadline, and race. Faults
 * are injected in the rig; nothing here opens a device file. Replaying a
 * recording always targets the simulator. A recording is not a script for
 * real hardware.
 */
export type AdapterChoice = "simulated" | "real";

export interface DeviceSelection {
  readonly id: string;
  readonly role: "sensor" | "output";
}

export interface RigConfig {
  readonly adapter: AdapterChoice;
  /** Starting state of the deterministic number generator. */
  readonly seed: number;
  readonly devices: readonly DeviceSelection[];
}

export type Fault =
  | "missing-reply"
  | "duplicate-reply"
  | "disconnect"
  | "stale-reading"
  | "malformed"
  | "crash"
  | "storage";

export interface RigClock {
  now(): number;
  advance(ms: number): void;
}

export function createClock(startMs = 0): RigClock {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms) {
      if (!Number.isInteger(ms) || ms < 0) {
        throw new Error("clock advance must be a non-negative integer");
      }
      nowMs += ms;
    },
  };
}

export interface RigResult {
  readonly atMs: number;
  readonly outcome: "confirmed" | "rejected" | "unknown" | "reading";
  readonly detail: string;
  readonly commandId?: string;
  readonly value?: boolean | number | null;
  readonly stale?: boolean;
  /** More than one when a duplicate reply was injected. The action still ran once. */
  readonly replies?: number;
}

export interface RecordedInput {
  readonly atMs: number;
  readonly type: "read" | "queue" | "flush" | "fault" | "advance" | "recover";
  readonly deviceId?: string;
  readonly commandId?: string;
  readonly value?: boolean;
  readonly deadlineMs?: number;
  readonly fault?: Fault;
  readonly ms?: number;
}

export interface FailureRig {
  readonly choice: AdapterChoice;
  /** How many times a real device file would have been opened. Always zero. */
  readonly realOpens: number;
  readonly clock: RigClock;
  read(deviceId: string): RigResult;
  queue(
    deviceId: string,
    commandId: string,
    value: boolean,
    deadlineMs: number,
  ): void;
  flush(): readonly RigResult[];
  inject(fault: Fault): void;
  recover(): void;
  recording(): readonly RecordedInput[];
  /** Output level after confirmed actuations. Undefined when the device is not an output. */
  outputLevel(deviceId: string): boolean | undefined;
}

export interface RigOptions {
  readonly clock?: RigClock;
  /**
   * Called only if the rig were about to open real hardware. The rig does
   * not call it. Tests pass a counter to prove that.
   */
  readonly openHardware?: () => void;
}

interface QueuedAction {
  readonly deviceId: string;
  readonly commandId: string;
  readonly value: boolean;
  readonly deadlineMs: number;
  readonly admittedAtMs: number;
}

export function createFailureRig(
  config: RigConfig,
  options: RigOptions = {},
): FailureRig {
  const innerClock = options.clock ?? createClock(0);
  const random = mulberry32(config.seed);
  const levels = new Map<string, boolean>();
  const applied = new Set<string>();
  const devices = new Map(config.devices.map((device) => [device.id, device]));
  for (const device of config.devices) {
    if (device.role === "output") levels.set(device.id, false);
  }
  const recording: RecordedInput[] = [];
  const queue: QueuedAction[] = [];
  const pendingFaults: Fault[] = [];
  let disconnected = false;
  let crashed = false;

  function stamp(input: RecordedInput): void {
    recording.push(input);
  }

  const clock: RigClock = {
    now: () => innerClock.now(),
    advance(ms) {
      innerClock.advance(ms);
      stamp({ atMs: innerClock.now(), type: "advance", ms });
    },
  };

  function disabled(detail: string, commandId?: string): RigResult {
    return {
      atMs: clock.now(),
      outcome: "rejected",
      detail,
      ...(commandId ? { commandId } : {}),
    };
  }

  function realResult(commandId?: string): RigResult {
    // Selecting the real adapter must not fall through to the simulator.
    return disabled("real device access is disabled", commandId);
  }

  const rig: FailureRig = {
    choice: config.adapter,
    get realOpens() {
      return 0;
    },
    clock,
    read(deviceId) {
      stamp({ atMs: clock.now(), type: "read", deviceId });
      if (config.adapter === "real") return realResult();
      if (crashed) throw new Error("simulated process crash");
      const device = devices.get(deviceId);
      if (!device) return disabled("unknown device");
      if (disconnected) {
        return {
          atMs: clock.now(),
          outcome: "reading",
          detail: "disconnected",
          value: null,
        };
      }
      const fault = takeFault("stale-reading", "malformed");
      if (fault === "malformed") {
        return {
          atMs: clock.now(),
          outcome: "reading",
          detail: "malformed message",
          value: null,
        };
      }
      if (device.role === "output") {
        return {
          atMs: clock.now(),
          outcome: "reading",
          detail: "level",
          value: levels.get(deviceId) ?? false,
          ...(fault === "stale-reading" ? { stale: true } : {}),
        };
      }
      const value = Math.round((20 + random() * 5) * 10) / 10;
      return {
        atMs: clock.now(),
        outcome: "reading",
        detail: "sensor",
        value,
        ...(fault === "stale-reading" ? { stale: true } : {}),
      };
    },
    queue(deviceId, commandId, value, deadlineMs) {
      stamp({
        atMs: clock.now(),
        type: "queue",
        deviceId,
        commandId,
        value,
        deadlineMs,
      });
      if (config.adapter === "real") return;
      queue.push({
        deviceId,
        commandId,
        value,
        deadlineMs,
        admittedAtMs: clock.now(),
      });
    },
    flush() {
      stamp({ atMs: clock.now(), type: "flush" });
      if (config.adapter === "real") {
        queue.length = 0;
        return [realResult()];
      }
      if (crashed) throw new Error("simulated process crash");
      const fault = takeFault("missing-reply", "duplicate-reply", "storage");
      const results: RigResult[] = [];
      const batch = queue.splice(0, queue.length);
      let faultForNext = fault;
      for (const action of batch) {
        results.push(runAction(action, faultForNext));
        faultForNext = undefined;
      }
      return results;
    },
    inject(fault) {
      stamp({ atMs: clock.now(), type: "fault", fault });
      if (config.adapter === "real") return;
      if (fault === "disconnect") {
        disconnected = true;
        return;
      }
      if (fault === "crash") {
        crashed = true;
        return;
      }
      pendingFaults.push(fault);
    },
    recover() {
      stamp({ atMs: clock.now(), type: "recover" });
      if (config.adapter === "real") return;
      crashed = false;
      disconnected = false;
    },
    recording() {
      return recording.slice();
    },
    outputLevel(deviceId) {
      return levels.get(deviceId);
    },
  };

  function takeFault(...kinds: Fault[]): Fault | undefined {
    const index = pendingFaults.findIndex((fault) => kinds.includes(fault));
    if (index < 0) return undefined;
    const [fault] = pendingFaults.splice(index, 1);
    return fault;
  }

  function runAction(
    action: QueuedAction,
    fault: Fault | undefined,
  ): RigResult {
    const atMs = clock.now();
    if (disconnected) {
      return {
        atMs,
        outcome: "rejected",
        detail: "disconnected",
        commandId: action.commandId,
      };
    }
    if (!devices.has(action.deviceId)) {
      return {
        atMs,
        outcome: "rejected",
        detail: "unknown device",
        commandId: action.commandId,
      };
    }
    if (!Number.isInteger(action.deadlineMs) || action.deadlineMs < 1) {
      return {
        atMs,
        outcome: "rejected",
        detail: "deadline expired",
        commandId: action.commandId,
      };
    }
    if (atMs - action.admittedAtMs > action.deadlineMs) {
      return {
        atMs,
        outcome: "rejected",
        detail: "deadline expired",
        commandId: action.commandId,
      };
    }
    if (applied.has(action.commandId)) {
      return {
        atMs,
        outcome: "confirmed",
        detail: "duplicate command was not applied again",
        commandId: action.commandId,
      };
    }
    if (fault === "storage") {
      return {
        atMs,
        outcome: "rejected",
        detail: "storage unavailable",
        commandId: action.commandId,
      };
    }
    const device = devices.get(action.deviceId);
    if (device?.role === "output") levels.set(action.deviceId, action.value);
    applied.add(action.commandId);
    if (fault === "missing-reply") {
      return {
        atMs,
        outcome: "unknown",
        detail: "reply missing; action was not retried",
        commandId: action.commandId,
      };
    }
    return {
      atMs,
      outcome: "confirmed",
      detail: "applied",
      commandId: action.commandId,
      ...(fault === "duplicate-reply" ? { replies: 2 } : {}),
    };
  }

  // `options.openHardware` is intentionally unused. Calling it would open a
  // real device. `realOpens` stays zero for the same reason.
  void options.openHardware;
  return rig;
}

/**
 * Play recorded inputs back into a fresh simulator. Refuses a real adapter
 * so a trace cannot energize hardware.
 */
export function replayRecording(
  config: RigConfig,
  inputs: readonly RecordedInput[],
): readonly RigResult[] {
  if (config.adapter !== "simulated") {
    throw new Error("refusing to replay a recording onto real hardware");
  }
  const clock = createClock(0);
  const rig = createFailureRig(config, { clock });
  const results: RigResult[] = [];
  for (const input of inputs) {
    if (input.type === "advance") {
      clock.advance(input.ms ?? 0);
      continue;
    }
    if (input.type === "fault" && input.fault) {
      rig.inject(input.fault);
      continue;
    }
    if (input.type === "recover") {
      rig.recover();
      continue;
    }
    if (input.type === "read" && input.deviceId) {
      results.push(rig.read(input.deviceId));
      continue;
    }
    if (
      input.type === "queue" &&
      input.deviceId &&
      input.commandId &&
      typeof input.value === "boolean" &&
      input.deadlineMs !== undefined
    ) {
      rig.queue(input.deviceId, input.commandId, input.value, input.deadlineMs);
      continue;
    }
    if (input.type === "flush") {
      results.push(...rig.flush());
    }
  }
  return results;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
