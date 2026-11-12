/**
 * Deterministic device simulator and failure rig (issue #7).
 *
 * The clock and the seed decide every reading, deadline, and race. Faults
 * are injected in the rig; nothing here opens a device file. Replaying a
 * recording always targets the simulator. A recording is not a script for
 * real hardware.
 *
 * The rig schedules operations on a fake clock and models device-side
 * behavior: deadlines, duplicate suppression, sensor roles, and reply
 * faults. It reports the shared action vocabulary, but durable queues,
 * persistence, and ownership belong to the journal (#10) and the gate
 * (#11); this rig must not grow a second copy of those rules. Simulated
 * crashing drops buffered work like lost RAM, while applied device
 * state survives like physical state. Selecting the real adapter calls
 * the caller's factory once per device and then refuses every
 * operation, so tests prove selection without touching hardware.
 *
 * Full #6 integration (shared device configuration, observations, and
 * the adapter contract) is still open: this rig keeps its own small
 * device roles until #32/#34 land, and issue #7 stays partly open.
 */
import type { ActionOutcome } from "@november/core";

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
  | "crash-after-apply"
  | "lost-request"
  | "storage";

const FAULTS: readonly Fault[] = [
  "missing-reply",
  "duplicate-reply",
  "disconnect",
  "stale-reading",
  "malformed",
  "crash",
  "crash-after-apply",
  "lost-request",
  "storage",
];

export interface RigClock {
  now(): number;
  advance(ms: number): void;
}

export function createClock(startMs = 0): RigClock {
  if (!Number.isInteger(startMs) || startMs < 0) {
    throw new Error("clock start must be a non-negative integer");
  }
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
  readonly outcome: ActionOutcome | "reading";
  readonly detail: string;
  readonly commandId?: string;
  readonly value?: boolean | number | null;
  /** When the returned reading was observed. Absent without an observation. */
  readonly observedAtMs?: number;
  readonly stale?: boolean;
  /** More than one when a duplicate reply was injected. The action still ran once. */
  readonly replies?: number;
}

export type RecordedInput =
  | { readonly atMs: number; readonly type: "read"; readonly deviceId: string }
  | {
      readonly atMs: number;
      readonly type: "queue";
      readonly deviceId: string;
      readonly commandId: string;
      readonly value: boolean;
      readonly deadlineMs: number;
    }
  | { readonly atMs: number; readonly type: "flush" }
  | { readonly atMs: number; readonly type: "fault"; readonly fault: Fault }
  | { readonly atMs: number; readonly type: "advance"; readonly ms: number }
  | { readonly atMs: number; readonly type: "recover" };

export interface FailureRig {
  readonly choice: AdapterChoice;
  /** Times the real-device factory was selected. Never called when simulated. */
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
  pendingFaults(): readonly Fault[];
  /** Output level after confirmed actuations. Undefined when the device is not an output. */
  outputLevel(deviceId: string): boolean | undefined;
}

export interface RigOptions {
  readonly clock?: RigClock;
  /**
   * Factory for real adapters, called once per selected device while the
   * adapter is "real". Tests pass a counter to prove selection; ordinary
   * simulated tests never trigger it.
   */
  readonly openReal?: (deviceId: string) => void;
}

interface QueuedAction {
  readonly deviceId: string;
  readonly commandId: string;
  readonly value: boolean;
  readonly deadlineMs: number;
  readonly admittedAtMs: number;
}

interface AppliedAction {
  readonly deviceId: string;
  readonly value: boolean;
}

interface RetainedReading {
  readonly value: boolean | number;
  readonly observedAtMs: number;
}

const CRASH_MESSAGE = "simulated process crash";

export function createFailureRig(
  config: RigConfig,
  options: RigOptions = {},
): FailureRig {
  checkConfig(config);
  const innerClock = options.clock ?? createClock(0);
  const random = mulberry32(config.seed);
  const levels = new Map<string, boolean>();
  const applied = new Map<string, AppliedAction>();
  const retained = new Map<string, RetainedReading>();
  const devices = new Map(config.devices.map((device) => [device.id, device]));
  for (const device of config.devices) {
    if (device.role === "output") levels.set(device.id, false);
  }
  const recording: RecordedInput[] = [];
  const queue: QueuedAction[] = [];
  const pendingFaults: Fault[] = [];
  const realSelected = new Set<string>();
  let realOpens = 0;
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

  // Real-mode selection reaches the caller's factory exactly once per
  // device, then every operation is refused. Nothing opens hardware here.
  function selectReal(deviceId: string): void {
    if (realSelected.has(deviceId)) return;
    realSelected.add(deviceId);
    realOpens += 1;
    options.openReal?.(deviceId);
  }

  function disabled(detail: string, commandId?: string): RigResult {
    return {
      atMs: clock.now(),
      outcome: "rejected",
      detail,
      ...(commandId ? { commandId } : {}),
    };
  }

  function realResult(commandId?: string): RigResult {
    return disabled("real device access is disabled", commandId);
  }

  const rig: FailureRig = {
    choice: config.adapter,
    get realOpens() {
      return realOpens;
    },
    clock,
    read(deviceId) {
      if (typeof deviceId !== "string" || deviceId.length === 0) {
        throw new Error("device id is required");
      }
      stamp({ atMs: clock.now(), type: "read", deviceId });
      if (config.adapter === "real") {
        selectReal(deviceId);
        return realResult();
      }
      if (crashed) throw new Error(CRASH_MESSAGE);
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
      if (fault === "stale-reading") {
        const previous = retained.get(deviceId);
        if (previous) {
          return {
            atMs: clock.now(),
            outcome: "reading",
            detail: "stale reading",
            value: previous.value,
            observedAtMs: previous.observedAtMs,
            stale: true,
          };
        }
      }
      const value =
        device.role === "output"
          ? (levels.get(deviceId) ?? false)
          : Math.round((20 + random() * 5) * 10) / 10;
      retained.set(deviceId, { value, observedAtMs: clock.now() });
      return {
        atMs: clock.now(),
        outcome: "reading",
        detail: device.role === "output" ? "level" : "sensor",
        value,
        observedAtMs: clock.now(),
        ...(fault === "stale-reading" ? { stale: true } : {}),
      };
    },
    queue(deviceId, commandId, value, deadlineMs) {
      if (typeof deviceId !== "string" || deviceId.length === 0) {
        throw new Error("device id is required");
      }
      if (typeof commandId !== "string" || commandId.length === 0) {
        throw new Error("command id is required");
      }
      if (typeof value !== "boolean") {
        throw new Error("queued value must be a boolean");
      }
      if (!Number.isInteger(deadlineMs) || deadlineMs < 1) {
        throw new Error("deadline must be a positive integer");
      }
      stamp({
        atMs: clock.now(),
        type: "queue",
        deviceId,
        commandId,
        value,
        deadlineMs,
      });
      if (config.adapter === "real") {
        selectReal(deviceId);
        return;
      }
      if (crashed) throw new Error(CRASH_MESSAGE);
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
      if (config.adapter === "real") return [];
      if (crashed) throw new Error(CRASH_MESSAGE);
      const results: RigResult[] = [];
      const batch = queue.splice(0, queue.length);
      for (const action of batch) {
        results.push(runAction(action));
      }
      return results;
    },
    inject(fault) {
      if (!FAULTS.includes(fault)) {
        throw new Error("unknown fault");
      }
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
      // Buffered work is lost RAM: it must never run after recovery.
      queue.length = 0;
      crashed = false;
      disconnected = false;
    },
    recording() {
      return recording.slice();
    },
    pendingFaults() {
      return pendingFaults.slice();
    },
    outputLevel(deviceId) {
      if (config.adapter === "real") return undefined;
      return levels.get(deviceId);
    },
  };

  // Faults attach only to eligible operations, in injection order. An
  // empty flush or an ineligible action never consumes them.
  function takeFault(...kinds: Fault[]): Fault | undefined {
    const index = pendingFaults.findIndex((fault) => kinds.includes(fault));
    if (index < 0) return undefined;
    const [fault] = pendingFaults.splice(index, 1);
    return fault;
  }

  function runAction(action: QueuedAction): RigResult {
    const atMs = clock.now();
    if (disconnected) {
      return {
        atMs,
        outcome: "rejected",
        detail: "disconnected",
        commandId: action.commandId,
      };
    }
    const device = devices.get(action.deviceId);
    if (!device) {
      return {
        atMs,
        outcome: "rejected",
        detail: "unknown device",
        commandId: action.commandId,
      };
    }
    if (atMs - action.admittedAtMs > action.deadlineMs) {
      return {
        atMs,
        outcome: "cancelled-before-dispatch",
        detail: "deadline expired before dispatch",
        commandId: action.commandId,
      };
    }
    const previous = applied.get(action.commandId);
    if (previous) {
      if (
        previous.deviceId !== action.deviceId ||
        previous.value !== action.value
      ) {
        return {
          atMs,
          outcome: "rejected",
          detail: "command id was already used with different parameters",
          commandId: action.commandId,
        };
      }
      return {
        atMs,
        outcome: "confirmed",
        detail: "duplicate command was not applied again",
        commandId: action.commandId,
      };
    }
    if (device.role !== "output") {
      return {
        atMs,
        outcome: "rejected",
        detail: "device does not support actuation",
        commandId: action.commandId,
      };
    }
    const fault = takeFault(
      "storage",
      "missing-reply",
      "duplicate-reply",
      "crash-after-apply",
      "lost-request",
    );
    if (fault === "storage") {
      return {
        atMs,
        outcome: "rejected",
        detail: "storage unavailable",
        commandId: action.commandId,
      };
    }
    if (fault === "lost-request") {
      return {
        atMs,
        outcome: "unknown",
        detail: "request lost before application; retry applies once",
        commandId: action.commandId,
      };
    }
    levels.set(action.deviceId, action.value);
    applied.set(action.commandId, {
      deviceId: action.deviceId,
      value: action.value,
    });
    if (fault === "missing-reply") {
      return {
        atMs,
        outcome: "unknown",
        detail: "reply missing; action was not retried",
        commandId: action.commandId,
      };
    }
    if (fault === "crash-after-apply") {
      crashed = true;
      throw new Error(CRASH_MESSAGE);
    }
    return {
      atMs,
      outcome: "confirmed",
      detail: "applied",
      commandId: action.commandId,
      ...(fault === "duplicate-reply" ? { replies: 2 } : {}),
    };
  }

  return rig;
}

function checkConfig(config: RigConfig): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("rig config must be an object");
  }
  if (config.adapter !== "simulated" && config.adapter !== "real") {
    throw new Error("rig adapter must be simulated or real");
  }
  if (typeof config.seed !== "number" || !Number.isFinite(config.seed)) {
    throw new Error("rig seed must be a finite number");
  }
  if (!Array.isArray(config.devices)) {
    throw new Error("rig devices must be a list");
  }
  const ids = new Set<string>();
  for (const device of config.devices) {
    if (
      !device ||
      typeof device !== "object" ||
      typeof device.id !== "string" ||
      device.id.length === 0 ||
      (device.role !== "sensor" && device.role !== "output")
    ) {
      throw new Error("rig device must have an id and a sensor/output role");
    }
    if (ids.has(device.id)) {
      throw new Error("rig device id is already defined");
    }
    ids.add(device.id);
  }
}

/**
 * Play recorded inputs back into a fresh simulator. Refuses a real adapter
 * so a trace cannot energize hardware. The replay clock starts from the
 * trace's own timestamps, so nonzero start times and time advanced on a
 * shared supplied clock reproduce; advance entries use their relative
 * duration (their stamp already includes it). Caught simulated crashes
 * produce no result for the interrupted operation, and replay continues
 * past recovery like the original session.
 */
export function replayRecording(
  config: RigConfig,
  inputs: readonly RecordedInput[],
): readonly RigResult[] {
  if (config.adapter !== "simulated") {
    throw new Error("refusing to replay a recording onto real hardware");
  }
  if (!Array.isArray(inputs)) {
    throw new Error("invalid recording: inputs must be a list");
  }
  for (const [index, input] of inputs.entries()) {
    const invalid = invalidInput(input);
    if (invalid) {
      throw new Error(`invalid recording entry ${index}: ${invalid}`);
    }
  }
  const clock = createClock(0);
  const rig = createFailureRig(config, { clock });
  const results: RigResult[] = [];
  for (const input of inputs) {
    if (input.type === "advance") {
      clock.advance(input.ms);
      continue;
    }
    // Catch up to the recorded time, reproducing advances made on a
    // shared clock outside the rig. Time never moves backwards.
    if (input.atMs > clock.now()) {
      clock.advance(input.atMs - clock.now());
    }
    try {
      if (input.type === "fault") {
        rig.inject(input.fault);
      } else if (input.type === "recover") {
        rig.recover();
      } else if (input.type === "read") {
        results.push(rig.read(input.deviceId));
      } else if (input.type === "queue") {
        rig.queue(
          input.deviceId,
          input.commandId,
          input.value,
          input.deadlineMs,
        );
      } else if (input.type === "flush") {
        results.push(...rig.flush());
      }
    } catch (error) {
      if (error instanceof Error && error.message === CRASH_MESSAGE) {
        continue;
      }
      throw error;
    }
  }
  return results;
}

function invalidInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "entry must be an object";
  }
  const entry = input as {
    readonly type?: unknown;
    readonly atMs?: unknown;
    readonly deviceId?: unknown;
    readonly commandId?: unknown;
    readonly value?: unknown;
    readonly deadlineMs?: unknown;
    readonly fault?: unknown;
    readonly ms?: unknown;
  };
  if (typeof entry.atMs !== "number" || !Number.isFinite(entry.atMs)) {
    return "atMs must be a finite number";
  }
  switch (entry.type) {
    case "read":
      return typeof entry.deviceId === "string" && entry.deviceId.length > 0
        ? undefined
        : "read needs a device id";
    case "queue":
      return typeof entry.deviceId === "string" &&
        entry.deviceId.length > 0 &&
        typeof entry.commandId === "string" &&
        entry.commandId.length > 0 &&
        typeof entry.value === "boolean" &&
        Number.isInteger(entry.deadlineMs)
        ? undefined
        : "queue needs a device, command, value, and deadline";
    case "flush":
    case "recover":
      return undefined;
    case "fault":
      return (FAULTS as readonly unknown[]).includes(entry.fault)
        ? undefined
        : "fault must be a known fault";
    case "advance":
      return Number.isInteger(entry.ms) && (entry.ms as number) >= 0
        ? undefined
        : "advance needs a non-negative integer duration";
    default:
      return "unknown entry type";
  }
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
