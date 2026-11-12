import { describe, expect, it } from "vitest";
import {
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

  it("expires a queued action on the fake clock before it is applied", () => {
    const rig = createFailureRig(simulated());
    rig.queue("host-led", "cmd-late", true, 100);
    rig.queue("host-led", "cmd-ok", true, 500);
    rig.clock.advance(101);
    const results = rig.flush();
    expect(results.map((result) => result.detail)).toEqual([
      "deadline expired",
      "applied",
    ]);
    expect(rig.outputLevel("host-led")).toBe(true);
    rig.queue("host-led", "cmd-ok", false, 100);
    expect(rig.flush()[0]?.detail).toBe(
      "duplicate command was not applied again",
    );
    expect(rig.outputLevel("host-led")).toBe(true);
  });

  it("injects missing replies, duplicates, disconnects, stale and malformed data", () => {
    const rig = createFailureRig(simulated());
    rig.inject("missing-reply");
    rig.queue("host-led", "cmd-miss", true, 1000);
    const missing = rig.flush()[0];
    expect(missing?.outcome).toBe("unknown");
    expect(rig.outputLevel("host-led")).toBe(true);
    rig.queue("host-led", "cmd-miss", false, 1000);
    expect(rig.flush()[0]?.outcome).toBe("confirmed");
    expect(rig.outputLevel("host-led")).toBe(true);

    rig.inject("duplicate-reply");
    rig.queue("host-led", "cmd-dup", false, 1000);
    const duplicate = rig.flush()[0];
    expect(duplicate?.replies).toBe(2);
    expect(rig.outputLevel("host-led")).toBe(false);

    rig.inject("stale-reading");
    expect(rig.read("bme280").stale).toBe(true);
    rig.inject("malformed");
    expect(rig.read("bme280")).toMatchObject({
      detail: "malformed message",
      value: null,
    });

    rig.inject("disconnect");
    expect(rig.read("bme280").value).toBeNull();
    rig.queue("host-led", "cmd-while-down", true, 1000);
    expect(rig.flush()[0]?.detail).toBe("disconnected");
    expect(rig.outputLevel("host-led")).toBe(false);
  });

  it("blocks new actions when storage fails and survives a simulated crash", () => {
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

    rig.inject("crash");
    expect(() => rig.read("bme280")).toThrow(/crash/);
    rig.recover();
    expect(rig.read("bme280").outcome).toBe("reading");
  });

  it("selects the real adapter explicitly and does not open hardware", () => {
    let opens = 0;
    const rig = createFailureRig(
      { adapter: "real", seed: 1, devices },
      {
        openHardware: () => {
          opens += 1;
        },
      },
    );
    expect(rig.read("bme280")).toMatchObject({
      outcome: "rejected",
      detail: "real device access is disabled",
    });
    rig.queue("host-led", "cmd-real", true, 1000);
    expect(rig.flush()[0]?.detail).toBe("real device access is disabled");
    expect(rig.outputLevel("host-led")).toBe(false);
    expect(opens).toBe(0);
    expect(rig.realOpens).toBe(0);

    const simulatedRig = createFailureRig(simulated());
    simulatedRig.queue("host-led", "cmd-sim", true, 1000);
    expect(simulatedRig.flush()[0]?.outcome).toBe("confirmed");
  });

  it("replays a recording in the simulator and refuses to replay it onto hardware", () => {
    const rig = createFailureRig(simulated(3));
    const seen: RigResult[] = [];
    seen.push(rig.read("bme280"));
    rig.clock.advance(50);
    rig.queue("host-led", "cmd-replay", true, 1000);
    seen.push(...rig.flush());
    const replayed = replayRecording(simulated(3), rig.recording());
    expect(replayed).toEqual(seen);
    expect(() =>
      replayRecording({ ...simulated(3), adapter: "real" }, rig.recording()),
    ).toThrow(/refusing to replay/);
  });
});
