import { describe, expect, it } from "vitest";
import {
  checkAdapterContract,
  type DeviceAction,
  type ResourceIdentity,
} from "@november/core";
import { createSimulatedAdapter } from "./simulated-adapter.js";

const configured: ResourceIdentity = {
  kind: "gpio",
  key: "gpio:gpiochip0:17",
  path: "gpiochip0/17",
};

const actuate: DeviceAction = {
  commandId: "cmd-on",
  deviceId: "host-led",
  operation: "set",
  payload: true,
  deadlineMs: 1000,
  expectedState: true,
};

describe("simulated adapter", () => {
  it("passes the shared adapter contract without hardware", async () => {
    const adapter = createSimulatedAdapter();
    const failures = await checkAdapterContract({
      adapter,
      configured,
      replugged: { ...configured, path: "gpiochip0/99" },
      replaced: { ...configured, key: "gpio:replaced" },
      deviceId: "host-led",
      readOperation: "level",
      foreignDeviceId: "other-led",
      actuate,
      actuateFresh: { ...actuate, commandId: "cmd-fresh" },
      unsupported: { ...actuate, commandId: "cmd-blink", operation: "blink" },
      nowMs: 5_000,
      actuationCount: () => adapter.actuationCount,
    });
    expect(failures).toEqual([]);
  });

  it("keeps authority on the identity key when the path changes", async () => {
    const adapter = createSimulatedAdapter();
    const before = adapter.actuationCount;
    const found = await adapter.discover();
    expect(adapter.actuationCount).toBe(before);
    expect(found.map((resource) => resource.identity.key)).toContain(
      "gpio:gpiochip0:17",
    );

    adapter.replug("host-led", "gpiochip0/99");
    const opened = await adapter.open(configured);
    expect(opened).toEqual({
      ok: true,
      identity: {
        kind: "gpio",
        key: "gpio:gpiochip0:17",
        path: "gpiochip0/99",
      },
    });
    expect(adapter.actuationCount).toBe(before);

    const replaced = createSimulatedAdapter();
    const refused = await replaced.open({
      ...configured,
      key: "gpio:someone-else",
    });
    expect(refused.ok).toBe(false);
    expect(replaced.actuationCount).toBe(0);
  });

  it("echoes stored outcomes without repeating the command", async () => {
    const adapter = createSimulatedAdapter();
    expect((await adapter.open(configured)).ok).toBe(true);
    const first = await adapter.execute(
      { ...actuate, commandId: "cmd-uncertain" },
      5_000,
    );
    expect(first.outcome).toBe("confirmed");
    const again = await adapter.reconcile("cmd-uncertain");
    expect(again).toEqual(first);
    expect(adapter.actuationCount).toBe(1);
    const unknown = await adapter.reconcile("cmd-never-sent");
    expect(unknown.outcome).toBe("unknown");
    expect(adapter.actuationCount).toBe(1);
  });
});
