import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_CUTOFF_MS,
  PICO_DEFAULT_ACTIVE_MS,
  PICO_MAX_ACTIVE_MS,
  createHostLed,
  createPicoLed,
} from "./watchdog.js";

describe("protected outputs", () => {
  it("starts disarmed and off, and a restart does not stay armed", () => {
    const led = createPicoLed();
    expect(led.armed).toBe(false);
    expect(led.on).toBe(false);
    expect(led.command("cmd-1", 1000, 0).accepted).toBe(false);
    expect(led.on).toBe(false);
    led.arm();
    led.heartbeat(0);
    led.command("cmd-1", 1000, 0);
    expect(led.on).toBe(true);
    const restarted = createPicoLed();
    expect(restarted.armed).toBe(false);
    expect(restarted.on).toBe(false);
  });

  it("enforces the deadline and ignores duplicates and heartbeats that would extend it", () => {
    const led = createPicoLed();
    led.arm();
    led.heartbeat(0);
    expect(led.command("cmd-1", undefined, 0).activeMs).toBe(
      PICO_DEFAULT_ACTIVE_MS,
    );
    expect(led.on).toBe(true);
    led.tick(PICO_DEFAULT_ACTIVE_MS - 1);
    expect(led.on).toBe(true);
    led.heartbeat(PICO_DEFAULT_ACTIVE_MS - 1);
    led.tick(PICO_DEFAULT_ACTIVE_MS);
    expect(led.on).toBe(false);

    const duration = createPicoLed();
    duration.arm();
    duration.heartbeat(10_000);
    expect(duration.command("cmd-2", PICO_MAX_ACTIVE_MS, 10_000).accepted).toBe(
      true,
    );
    expect(duration.on).toBe(true);
    for (let t = 11_000; t <= 39_000; t += 1000) {
      duration.heartbeat(t);
      duration.tick(t);
      expect(duration.on).toBe(true);
    }
    expect(
      duration.command("cmd-2", PICO_MAX_ACTIVE_MS, 39_000).detail,
    ).toMatch(/duplicate/);
    duration.heartbeat(39_999);
    duration.tick(39_999);
    expect(duration.on).toBe(true);
    duration.tick(40_000);
    expect(duration.on).toBe(false);
    expect(duration.armed).toBe(true);
    duration.heartbeat(50_000);
    expect(
      duration.command("cmd-3", PICO_MAX_ACTIVE_MS + 1, 50_000).detail,
    ).toMatch(/duration/);
  });

  it("cuts the output within 2s of the last heartbeat without a model call", () => {
    const led = createPicoLed();
    led.arm();
    led.heartbeat(0);
    expect(led.command("cmd-1", 30_000, 0).accepted).toBe(true);
    expect(led.on).toBe(true);
    led.tick(HEARTBEAT_CUTOFF_MS - 1);
    expect(led.on).toBe(true);
    led.tick(HEARTBEAT_CUTOFF_MS);
    expect(led.on).toBe(false);
  });

  it("refuses a fresh command while the output is on without moving the deadline", () => {
    const led = createPicoLed();
    led.arm();
    led.heartbeat(0);
    expect(led.command("a", 30_000, 0).accepted).toBe(true);
    expect(led.on).toBe(true);
    for (let t = 1000; t <= 29_000; t += 1000) {
      led.heartbeat(t);
      led.tick(t);
      expect(led.on).toBe(true);
    }
    const busy = led.command("b", 30_000, 29_000);
    expect(busy.accepted).toBe(false);
    expect(busy.detail).toBe("output is already on");
    led.heartbeat(29_999);
    led.tick(29_999);
    expect(led.on).toBe(true);
    led.tick(30_000);
    expect(led.on).toBe(false);
    // The refused id was never recorded, so it can be used afterwards.
    led.heartbeat(30_000);
    expect(led.command("b", 1000, 30_000).accepted).toBe(true);
    expect(led.on).toBe(true);
  });

  it("keeps the original deadline when a shorter command arrives while on", () => {
    const led = createPicoLed();
    led.arm();
    led.heartbeat(0);
    expect(led.command("a", 30_000, 0).accepted).toBe(true);
    expect(led.on).toBe(true);
    led.heartbeat(1000);
    const busy = led.command("c", 1000, 1000);
    expect(busy.accepted).toBe(false);
    expect(busy.detail).toBe("output is already on");
    for (let t = 2000; t <= 29_000; t += 1000) {
      led.heartbeat(t);
      led.tick(t);
    }
    led.heartbeat(29_999);
    led.tick(29_999);
    expect(led.on).toBe(true);
    led.tick(30_000);
    expect(led.on).toBe(false);
  });

  it("keeps heartbeat protection across a repeated arm", () => {
    const led = createPicoLed();
    led.arm();
    led.heartbeat(0);
    expect(led.command("a", 30_000, 0).accepted).toBe(true);
    expect(led.on).toBe(true);
    led.arm();
    led.tick(1999);
    expect(led.on).toBe(true);
    led.tick(2000);
    expect(led.on).toBe(false);
  });

  it("refuses commands on a stale heartbeat, including at the 2s boundary", () => {
    const led = createPicoLed();
    led.arm();
    led.heartbeat(0);
    led.tick(10_000);
    expect(led.on).toBe(false);
    expect(led.command("a", 30_000, 10_000).accepted).toBe(false);
    expect(led.on).toBe(false);

    const fresh = createPicoLed();
    fresh.arm();
    fresh.heartbeat(0);
    expect(fresh.command("a", 30_000, 1999).accepted).toBe(true);
    expect(fresh.on).toBe(true);

    const boundary = createPicoLed();
    boundary.arm();
    boundary.heartbeat(0);
    expect(boundary.command("a", 30_000, 2000).accepted).toBe(false);
    expect(boundary.on).toBe(false);

    const none = createPicoLed();
    none.arm();
    expect(none.command("a", 30_000, 0).accepted).toBe(false);
    expect(none.on).toBe(false);
  });

  it("disarms on heartbeat cutoff but stays armed on normal expiry", () => {
    const cut = createPicoLed();
    cut.arm();
    cut.heartbeat(0);
    expect(cut.command("a", 30_000, 0).accepted).toBe(true);
    cut.tick(2000);
    expect(cut.on).toBe(false);
    expect(cut.armed).toBe(false);
    cut.heartbeat(2001);
    expect(cut.command("b", 1000, 2001).detail).toBe("disarmed");
    cut.arm();
    cut.heartbeat(2001);
    expect(cut.command("b", 1000, 2001).accepted).toBe(true);
    expect(cut.on).toBe(true);

    const expired = createPicoLed();
    expired.arm();
    expired.heartbeat(0);
    expect(expired.command("a", 1000, 0).accepted).toBe(true);
    expired.heartbeat(999);
    expired.tick(1000);
    expect(expired.on).toBe(false);
    expect(expired.armed).toBe(true);
  });

  it("settles elapsed limits before late events, including rejected commands", () => {
    const cases = [
      [1000, true], // Duration expires before heartbeat loss.
      [2000, true], // Equal limits preserve normal completion.
      [3000, false], // Heartbeat loss interrupts the action first.
    ] as const;
    for (const [activeMs, remainsArmed] of cases) {
      for (const event of ["heartbeat", "tick", "command"] as const) {
        const led = createPicoLed();
        led.arm();
        led.heartbeat(0);
        expect(led.command("a", activeMs, 0).accepted).toBe(true);
        expect(led.on).toBe(true);
        if (event === "heartbeat") led.heartbeat(3500);
        else if (event === "tick") led.tick(3500);
        else {
          expect(led.command("bad", 30_001, 3500).accepted).toBe(false);
        }
        expect(led.on).toBe(false);
        expect(led.armed).toBe(remainsArmed);
      }
    }
  });

  it("disarm switches off immediately and preserves command history", () => {
    const led = createPicoLed();
    led.arm();
    led.heartbeat(0);
    expect(led.command("a", 2000, 0).accepted).toBe(true);
    expect(led.on).toBe(true);
    led.disarm();
    expect(led.on).toBe(false);
    expect(led.armed).toBe(false);
    expect(led.command("b", 1000, 100).detail).toBe("disarmed");
    led.arm();
    expect(led.command("b", 1000, 100).accepted).toBe(false);
    led.heartbeat(100);
    expect(led.command("a", 1000, 100).detail).toMatch(/duplicate/);
    expect(led.on).toBe(false);
    expect(led.command("b", 1000, 100).accepted).toBe(true);
    expect(led.on).toBe(true);
  });

  it("fails toward off on non-finite time", () => {
    const led = createPicoLed();
    led.arm();
    led.heartbeat(0);
    expect(led.command("a", 1000, Number.NaN).accepted).toBe(false);
    expect(led.on).toBe(false);
    expect(led.command("a", 1000, 0).accepted).toBe(true);
    expect(led.on).toBe(true);
    led.heartbeat(Number.NaN);
    led.tick(Number.NaN);
    expect(led.on).toBe(false);
  });

  it("leaves the host diagnostic LED on until shutdown", () => {
    const led = createHostLed();
    led.set(true);
    expect(led.on).toBe(true);
    led.shutdown();
    expect(led.on).toBe(false);
  });
});
