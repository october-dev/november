import { describe, expect, it } from "vitest";
import { ACTION_OUTCOMES, isUncertain } from "./outcomes.js";

describe("action outcomes", () => {
  it("matches the release-contract vocabulary exactly", () => {
    // Frozen by docs/release-gates.md "Outcome semantics"; changing this set
    // is a contract change owned by issue #10, not a casual edit.
    expect([...ACTION_OUTCOMES]).toEqual([
      "rejected",
      "queued",
      "dispatched",
      "confirmed",
      "failed",
      "cancelled-before-dispatch",
      "unknown",
    ]);
  });

  it("flags only unknown as uncertain", () => {
    expect(isUncertain("unknown")).toBe(true);
    for (const outcome of ACTION_OUTCOMES) {
      if (outcome !== "unknown") {
        expect(isUncertain(outcome)).toBe(false);
      }
    }
  });
});
