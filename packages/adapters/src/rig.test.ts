import { describe, expect, it } from "vitest";
import {
  createClock,
  createFailureRig,
  replayRecording,
  type RigConfig,
  type RigResult,
} from "./rig.js";

const devices = [
  { id: "bme280", role: "sensor" as const },
  { id: "host-led", role: "output" as const },
];

function simulated(seed = 1): RigConfig {
  return { adapter: "simulated", seed, devices };
}

describe("failure rig", () => {
  it("repeats sensor readings from the same seed and not from another", () => {
    const first = createFailureRig(simulated(7));
    const second = createFailureRig(simulated(7));
    const third = createFailureRig(simulated(8));
    const a = [first.read("bme280").value, first.read("bme280").value];
    const b = [second.read("bme280").value, second.read("bme280").value];
    const c = [third.read("bme280").value, third.read("bme280").value];
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
  });

  it("cancels expired queued actions before dispatch, with the boundary running", () => {
    const rig = createFailureRig(simulated());
    rig.queue("host-led", "cmd-late", true, 100);
    rig.queue("host-led", "cmd-ok", true, 500);
    rig.clock.advance(101);
    const results = rig.flush();
    expect(results.map((result) => result.outcome)).toEqual([
      "cancelled-before-dispatch",
      "confirmed",
    ]);
    expect(rig.outputLevel("host-led")).toBe(true);

    const edge = createFailureRig(simulated());
    edge.queue("host-led", "cmd-edge", true, 100);
    edge.clock.advance(100);
    expect(edge.flush()[0]?.outcome).toBe("confirmed");
  });

  it("rejects id reuse with different parameters without changing outputs", () => {
    const rig = createFailureRig(simulated());
    rig.queue("host-led", "cmd-1", true, 1000);
    expect(rig.flush()[0]?.outcome).toBe("confirmed");
    expect(rig.outputLevel("host-led")).toBe(true);
    rig.queue("host-led", "cmd-1", true, 1000);
    expect(rig.flush()[0]).toMatchObject({
      outcome: "confirmed",
      detail: "duplicate command was not applied again",
    });

    rig.queue("host-led", "cmd-1", false, 1000);
    expect(rig.flush()[0]).toMatchObject({
      outcome: "rejected",
      detail: "command id was already used with different parameters",
    });
    expect(rig.outputLevel("host-led")).toBe(true);

    rig.queue("bme280", "cmd-1", true, 1000);
    expect(rig.flush()[0]).toMatchObject({
      outcome: "rejected",
      detail: "command id was already used with different parameters",
    });
    expect(rig.outputLevel("host-led")).toBe(true);
  });

  it("rejects sensor actuation without recording success", () => {
    const rig = createFailureRig(simulated());
    rig.queue("bme280", "cmd-x", true, 1000);
    expect(rig.flush()[0]).toMatchObject({
      outcome: "rejected",
      detail: "device does not support actuation",
    });
    // The rejected id was never recorded, so it stays usable.
    rig.queue("host-led", "cmd-x", true, 1000);
    expect(rig.flush()[0]?.outcome).toBe("confirmed");
    expect(rig.outputLevel("host-led")).toBe(true);
  });

  it("injects missing replies, duplicates, stale and malformed data", () => {
    const rig = createFailureRig(simulated());
    rig.inject("missing-reply");
    rig.queue("host-led", "cmd-miss", true, 1000);
    const missing = rig.flush()[0];
    expect(missing?.outcome).toBe("unknown");
    expect(rig.outputLevel("host-led")).toBe(true);
    rig.queue("host-led", "cmd-miss", true, 1000);
    expect(rig.flush()[0]?.outcome).toBe("confirmed");
    expect(rig.outputLevel("host-led")).toBe(true);

    rig.inject("duplicate-reply");
    rig.queue("host-led", "cmd-dup", false, 1000);
    const duplicate = rig.flush()[0];
    expect(duplicate?.replies).toBe(2);
    expect(rig.outputLevel("host-led")).toBe(false);

    const fresh = rig.read("bme280");
    rig.inject("stale-reading");
    const stale = rig.read("bme280");
    expect(stale.stale).toBe(true);
    expect(stale.value).toBe(fresh.value);
    expect(stale.observedAtMs).toBe(fresh.observedAtMs);
    rig.inject("malformed");
    const malformed = rig.read("bme280");
    expect(malformed).toMatchObject({
      detail: "malformed message",
      value: null,
    });
    expect(malformed.observedAtMs).toBeUndefined();
  });

  it("retains a fault until its eligible operation", () => {
    const rig = createFailureRig(simulated());
    rig.inject("missing-reply");
    expect(rig.flush()).toEqual([]);
    expect(rig.pendingFaults()).toEqual(["missing-reply"]);
    rig.queue("host-led", "cmd-later", true, 1000);
    expect(rig.flush()[0]?.outcome).toBe("unknown");
    expect(rig.pendingFaults()).toEqual([]);

    rig.inject("duplicate-reply");
    rig.queue("missing-led", "cmd-bad", true, 1000);
    rig.queue("host-led", "cmd-good", true, 1000);
    const results = rig.flush();
    expect(results.map((result) => result.outcome)).toEqual([
      "rejected",
      "confirmed",
    ]);
    expect(results[1]?.replies).toBe(2);
    expect(rig.pendingFaults()).toEqual([]);
  });

  it("blocks the action when storage fails, without recording it", () => {
    const rig = createFailureRig(simulated());
    rig.inject("storage");
    rig.queue("host-led", "cmd-disk", true, 1000);
    expect(rig.flush()[0]).toMatchObject({
      outcome: "rejected",
      detail: "storage unavailable",
    });
    expect(rig.outputLevel("host-led")).toBe(false);
    rig.queue("host-led", "cmd-disk", true, 1000);
    expect(rig.flush()[0]?.outcome).toBe("confirmed");
  });

  it("loses a lost request before application, so a retry applies once", () => {
    const rig = createFailureRig(simulated());
    rig.inject("lost-request");
    rig.queue("host-led", "cmd-lost", true, 1000);
    expect(rig.flush()[0]?.outcome).toBe("unknown");
    expect(rig.outputLevel("host-led")).toBe(false);
    rig.queue("host-led", "cmd-lost", true, 1000);
    expect(rig.flush()[0]?.outcome).toBe("confirmed");
    expect(rig.outputLevel("host-led")).toBe(true);
  });

  it("preserves applied work across a crash after application", () => {
    const rig = createFailureRig(simulated());
    rig.inject("crash-after-apply");
    rig.queue("host-led", "cmd-crash", true, 1000);
    expect(() => rig.flush()).toThrow(/simulated process crash/);
    expect(rig.outputLevel("host-led")).toBe(true);
    rig.recover();
    rig.queue("host-led", "cmd-crash", true, 1000);
    expect(rig.flush()[0]).toMatchObject({
      outcome: "confirmed",
      detail: "duplicate command was not applied again",
    });
  });

  it("never runs work buffered across crash or disconnect recovery", () => {
    const rig = createFailureRig(simulated());
    rig.queue("host-led", "cmd-before", true, 1000);
    rig.inject("crash");
    expect(() => rig.queue("host-led", "cmd-during", true, 1000)).toThrow(
      /simulated process crash/,
    );
    rig.recover();
    expect(rig.flush()).toEqual([]);
    expect(rig.outputLevel("host-led")).toBe(false);

    rig.inject("disconnect");
    expect(rig.read("bme280").value).toBeNull();
    rig.queue("host-led", "cmd-while-down", true, 1000);
    expect(rig.flush()[0]?.detail).toBe("disconnected");
    rig.queue("host-led", "cmd-offline", true, 1000);
    rig.recover();
    expect(rig.flush()).toEqual([]);
    expect(rig.outputLevel("host-led")).toBe(false);
  });

  it("survives a simulated crash and keeps reading afterwards", () => {
    const rig = createFailureRig(simulated());
    rig.inject("crash");
    expect(() => rig.read("bme280")).toThrow(/crash/);
    rig.recover();
    expect(rig.read("bme280").outcome).toBe("reading");
  });

  it("selects the real adapter through the factory and refuses every operation", () => {
    const opened: string[] = [];
    const rig = createFailureRig(
      { adapter: "real", seed: 1, devices },
      {
        openReal: (deviceId) => {
          opened.push(deviceId);
        },
      },
    );
    expect(rig.read("bme280")).toMatchObject({
      outcome: "rejected",
      detail: "real device access is disabled",
    });
    rig.queue("host-led", "cmd-real", true, 1000);
    expect(rig.flush()).toEqual([]);
    expect(rig.outputLevel("host-led")).toBeUndefined();
    expect(opened).toEqual(["bme280", "host-led"]);
    expect(rig.realOpens).toBe(2);
    // One selection per device, not per operation.
    expect(rig.read("bme280").outcome).toBe("rejected");
    expect(rig.realOpens).toBe(2);

    let simulatedOpens = 0;
    const simulatedRig = createFailureRig(simulated(), {
      openReal: () => {
        simulatedOpens += 1;
      },
    });
    simulatedRig.read("bme280");
    simulatedRig.queue("host-led", "cmd-sim", true, 1000);
    expect(simulatedRig.flush()[0]?.outcome).toBe("confirmed");
    expect(simulatedOpens).toBe(0);
    expect(simulatedRig.realOpens).toBe(0);
  });

  it("replays a recording in the simulator and refuses to replay it onto hardware", () => {
    const rig = createFailureRig(simulated(3));
    const seen: RigResult[] = [];
    seen.push(rig.read("bme280"));
    rig.clock.advance(50);
    rig.queue("host-led", "cmd-replay", true, 1000);
    seen.push(...rig.flush());
    seen.push(rig.read("host-led"));
    const replayed = replayRecording(simulated(3), rig.recording());
    expect(replayed).toEqual(seen);
    expect(() =>
      replayRecording({ ...simulated(3), adapter: "real" }, rig.recording()),
    ).toThrow(/refusing to replay/);
  });

  it("replays nonzero start times and externally advanced clocks", () => {
    const rig = createFailureRig(simulated(3), { clock: createClock(500) });
    const seen: RigResult[] = [];
    seen.push(rig.read("bme280"));
    rig.queue("host-led", "cmd-late", true, 100);
    rig.clock.advance(101);
    seen.push(...rig.flush());
    expect(seen.map((result) => result.atMs)).toEqual([500, 601]);
    expect(replayRecording(simulated(3), rig.recording())).toEqual(seen);

    const external = createClock(0);
    const shared = createFailureRig(simulated(3), { clock: external });
    shared.queue("host-led", "cmd-x", true, 100);
    external.advance(101);
    const expired = shared.flush();
    expect(expired[0]?.outcome).toBe("cancelled-before-dispatch");
    expect(replayRecording(simulated(3), shared.recording())).toEqual(expired);
  });

  it("replays a caught crash followed by recovery", () => {
    const rig = createFailureRig(simulated(3));
    const seen: RigResult[] = [];
    seen.push(rig.read("bme280"));
    rig.inject("crash");
    expect(() => rig.flush()).toThrow(/crash/);
    rig.recover();
    rig.queue("host-led", "cmd-after", true, 1000);
    seen.push(...rig.flush());
    expect(replayRecording(simulated(3), rig.recording())).toEqual(seen);
  });

  it("rejects incomplete and malformed recordings", () => {
    expect(() => replayRecording(simulated(3), "nope" as never)).toThrow(
      /must be a list/,
    );
    expect(() =>
      replayRecording(simulated(3), [{ atMs: 0, type: "read" }] as never),
    ).toThrow(/device id/);
    expect(() =>
      replayRecording(simulated(3), [
        { atMs: 0, type: "fault", fault: "bogus" },
      ] as never),
    ).toThrow(/known fault/);
    expect(() =>
      replayRecording(simulated(3), [{ atMs: 0, type: "advance" }] as never),
    ).toThrow(/duration/);
    expect(() =>
      replayRecording(simulated(3), [
        { atMs: 0, type: "queue", deviceId: "host-led" },
      ] as never),
    ).toThrow(/device, command, value/);
    expect(() =>
      replayRecording(simulated(3), [{ atMs: "x", type: "flush" }] as never),
    ).toThrow(/atMs/);
    expect(() =>
      replayRecording(simulated(3), [{ atMs: 0, type: "explode" }] as never),
    ).toThrow(/unknown entry type/);
  });

  it("reports stale-reading age from observation time across the 10s boundary", () => {
    const rig = createFailureRig(simulated());
    const first = rig.read("bme280");
    expect(first.observedAtMs).toBe(first.atMs);
    rig.clock.advance(9999);
    rig.inject("stale-reading");
    const under = rig.read("bme280");
    expect(under.stale).toBe(true);
    expect(under.value).toBe(first.value);
    expect(under.observedAtMs).toBe(first.observedAtMs);
    expect(under.atMs - (under.observedAtMs ?? 0)).toBe(9999);
    rig.clock.advance(1);
    rig.inject("stale-reading");
    const boundary = rig.read("bme280");
    expect(boundary.atMs - (boundary.observedAtMs ?? 0)).toBe(10_000);
    expect(boundary.value).toBe(first.value);
  });

  it("validates rig inputs instead of mislabeling them", () => {
    const rig = createFailureRig(simulated());
    expect(() => rig.queue("", "cmd-1", true, 100)).toThrow(/device id/);
    expect(() => rig.queue("host-led", "", true, 100)).toThrow(/command id/);
    for (const deadline of [0, -5, 1.5, Number.NaN]) {
      expect(() => rig.queue("host-led", "cmd-1", true, deadline)).toThrow(
        /deadline must be a positive integer/,
      );
    }
    expect(() => rig.queue("host-led", "cmd-1", "yes" as never, 100)).toThrow(
      /must be a boolean/,
    );
    expect(() => rig.read("")).toThrow(/device id/);
    expect(() => rig.inject("bogus" as never)).toThrow(/unknown fault/);
    expect(() => createClock(-1)).toThrow(/non-negative integer/);
    expect(() => createClock(Number.NaN)).toThrow(/non-negative integer/);
    expect(() => createClock(1.5)).toThrow(/non-negative integer/);
    expect(() =>
      createFailureRig({ ...simulated(), seed: Number.NaN }),
    ).toThrow(/finite number/);
    expect(() =>
      createFailureRig({
        ...simulated(),
        devices: [...devices, { id: "host-led", role: "sensor" as const }],
      }),
    ).toThrow(/already defined/);
    expect(() =>
      createFailureRig({
        ...simulated(),
        devices: [{ id: "x", role: "motor" as never }],
      }),
    ).toThrow(/sensor\/output role/);
  });
});
