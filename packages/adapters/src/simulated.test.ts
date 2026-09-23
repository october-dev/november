import { describe, expect, it } from "vitest";
import { listSimulatedDevices } from "./simulated.js";

describe("simulated device registry", () => {
  it("covers every peripheral role in the reference setup", () => {
    const kinds = listSimulatedDevices().map((device) => device.kind);
    expect(new Set(kinds)).toEqual(
      new Set(["led", "button", "pico", "bme280", "spi-loopback"]),
    );
  });

  it("assigns unique ids", () => {
    const ids = listSimulatedDevices().map((device) => device.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
