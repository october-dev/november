import { describe, expect, it } from "vitest";
import {
  EXECUTOR_PROTOCOL_VERSION,
  executorStatus,
  UNIMPLEMENTED_OUTCOME,
} from "./index.js";

describe("executor scaffold", () => {
  it("starts not ready and disarmed", () => {
    // docs/support-matrix.md safe states: restart or reconnection never auto-arms.
    const status = executorStatus();
    expect(status.armed).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.protocolVersion).toBe(EXECUTOR_PROTOCOL_VERSION);
  });

  it("reports rejected, never a fabricated success", () => {
    expect(UNIMPLEMENTED_OUTCOME).toBe("rejected");
  });
});
