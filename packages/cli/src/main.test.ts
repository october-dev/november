import { describe, expect, it } from "vitest";
import { run } from "./main.js";

describe("cli", () => {
  it("prints versions for --version", () => {
    const result = run(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("@november/cli");
    expect(result.output).toContain("@november/core");
    expect(result.output).toContain("@november/adapters");
  });

  it("prints help for --help and exits nonzero with no args", () => {
    expect(run(["--help"]).exitCode).toBe(0);
    expect(run([]).exitCode).toBe(1);
    expect(run([]).output).toContain("Usage:");
  });

  it("doctor lists simulated devices without touching hardware", () => {
    const result = run(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("sim-pico");
    expect(result.output).toContain("sim-bme280");
    expect(result.output).toContain(process.version);
  });

  it("rejects unknown commands", () => {
    const result = run(["launch-missiles"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("unknown command");
  });
});
