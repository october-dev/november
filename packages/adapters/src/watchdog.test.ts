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
    led.command("cmd-1", 1000, 0);
    expect(led.on).toBe(true);
    const restarted = createPicoLed();
    expect(restarted.armed).toBe(false);
    expect(restarted.on).toBe(false);
  });

  it("enforces the deadline and ignores duplicates and heartbeats that would extend it", () => {
    const led = createPicoLed();
    led.arm();
    expect(led.command("cmd-1", undefined, 0).activeMs).toBe(
      PICO_DEFAULT_ACTIVE_MS,
    );
    led.tick(PICO_DEFAULT_ACTIVE_MS - 1);
    expect(led.on).toBe(true);
    led.heartbeat(PICO_DEFAULT_ACTIVE_MS - 1);
    led.tick(PICO_DEFAULT_ACTIVE_MS);
    expect(led.on).toBe(false);

    led.command("cmd-2", PICO_MAX_ACTIVE_MS, 10_000);
    expect(led.command("cmd-2", PICO_MAX_ACTIVE_MS, 10_000).detail).toMatch(
      /duplicate/,
    );
    led.heartbeat(39_000);
    led.tick(40_000);
    expect(led.on).toBe(false);
    expect(led.command("cmd-3", PICO_MAX_ACTIVE_MS + 1, 50_000).accepted).toBe(
      false,
    );
  });

  it("cuts the output within 2s of the last heartbeat without a model call", () => {
    const led = createPicoLed();
    led.arm();
    led.command("cmd-1", 30_000, 0);
    led.heartbeat(0);
    led.tick(HEARTBEAT_CUTOFF_MS - 1);
    expect(led.on).toBe(true);
    led.tick(HEARTBEAT_CUTOFF_MS);
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
