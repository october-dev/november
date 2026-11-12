import { describe, expect, it } from "vitest";
import { createResourceGate } from "./gate.js";

describe("resource gate", () => {
  it("gives one device a single owner and rejects a stale generation", () => {
    const gate = createResourceGate({ leaseMs: 100 });
    const first = gate.claim("host-led", "worker-a", 0);
    expect(first.accepted).toBe(true);
    expect(gate.claim("host-led", "worker-b", 10).detail).toBe(
      "device has a live owner",
    );
    const restarted = gate.claim("host-led", "worker-a", 200);
    expect(restarted.generation).toBe((first.generation ?? 0) + 1);
    expect(
      gate.submit("host-led", "worker-a", first.generation ?? 0, "actuate", 200)
        .detail,
    ).toBe("stale owner");
    expect(
      gate.submit(
        "host-led",
        "worker-a",
        restarted.generation ?? 0,
        "actuate",
        200,
      ).detail,
    ).toBe("started");
  });

  it("serializes actuations, counts allowance once, and lets stop jump the queue", () => {
    const gate = createResourceGate({
      queueLimit: 1,
      allowance: 2,
      leaseMs: 1_000,
    });
    const claim = gate.claim("host-led", "worker-a", 0);
    const generation = claim.generation ?? 0;
    expect(
      gate.submit("host-led", "worker-a", generation, "actuate", 10).detail,
    ).toBe("started");
    expect(gate.remaining("host-led")).toBe(1);
    expect(
      gate.submit("host-led", "worker-a", generation, "actuate", 11).detail,
    ).toBe("queued");
    expect(
      gate.submit("host-led", "worker-a", generation, "read", 12).detail,
    ).toBe("queue is full");
    expect(
      gate.submit("host-led", "worker-a", generation, "stop", 13),
    ).toMatchObject({
      accepted: true,
      detail: "stopped",
    });
    expect(gate.depth("host-led")).toBe(0);
    expect(gate.finish("host-led", "worker-a", generation, 14).detail).toBe(
      "idle",
    );
  });

  it("does not start queued work for a dead owner", () => {
    const gate = createResourceGate({ leaseMs: 50, allowance: 5 });
    const claim = gate.claim("host-led", "worker-a", 0);
    const generation = claim.generation ?? 0;
    gate.submit("host-led", "worker-a", generation, "actuate", 0);
    gate.submit("host-led", "worker-a", generation, "actuate", 0);
    expect(gate.finish("host-led", "worker-a", generation, 1_000).detail).toBe(
      "queued work expired",
    );
    const replacement = gate.claim("host-led", "worker-b", 1_000);
    expect(replacement.accepted).toBe(true);
    expect(
      gate.submit("host-led", "worker-a", generation, "actuate", 1_010).detail,
    ).toBe("stale owner");
  });

  it("rejects a second actuation once the shared allowance is spent", () => {
    const gate = createResourceGate({ allowance: 1 });
    const claim = gate.claim("host-led", "worker-a", 0);
    const generation = claim.generation ?? 0;
    expect(
      gate.submit("host-led", "worker-a", generation, "actuate", 0).accepted,
    ).toBe(true);
    gate.finish("host-led", "worker-a", generation, 1);
    expect(
      gate.submit("host-led", "worker-a", generation, "actuate", 2).detail,
    ).toBe("allowance exhausted");
    expect(
      gate.submit("host-led", "worker-a", generation, "stop", 3).accepted,
    ).toBe(true);
  });
});
