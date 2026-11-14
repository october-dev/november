import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDeviceAgent,
  HARDWARE_TOOL_NAME,
  type ExecutionClient,
} from "./index.js";

describe("session bounds", () => {
  it("trims old messages but keeps submitted command ids", async () => {
    const sessionDirectory = mkdtempSync(
      path.join(tmpdir(), "november-session-"),
    );
    const client: ExecutionClient = {
      async submit() {
        return { outcome: "confirmed", detail: "once" };
      },
    };
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory,
      execution: client,
      limits: { maxSessionMessages: 2, maxSessionBytes: 4_096 },
      provider: {
        kind: "fake",
        script: [
          {
            type: "tool",
            name: HARDWARE_TOOL_NAME,
            arguments: {
              commandId: "cmd-keep",
              deviceId: "sim-host-led",
              operation: "actuate",
              deadlineMs: 1000,
              payload: null,
            },
          },
          { type: "text", text: "a" },
          { type: "text", text: "b" },
          { type: "text", text: "c" },
        ],
      },
    });
    await agent.run("first ".repeat(30));
    await agent.run("second ".repeat(30));
    await agent.run("third ".repeat(30));
    const saved = JSON.parse(readFileSync(agent.sessionPath, "utf8")) as {
      messages: unknown[];
      submitted: { request: { commandId: string } }[];
    };
    expect(saved.messages.length).toBeLessThanOrEqual(2);
    expect(saved.submitted.map((entry) => entry.request.commandId)).toEqual([
      "cmd-keep",
    ]);
    expect(statSync(agent.sessionPath).mode & 0o077).toBe(0);
  });

  it("trims whole groups so tool results stay with their calls", async () => {
    const sessionDirectory = mkdtempSync(
      path.join(tmpdir(), "november-session-"),
    );
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory,
      execution: {
        async submit() {
          return { outcome: "confirmed", detail: "ok" };
        },
      },
      limits: { maxSessionMessages: 3 },
      provider: {
        kind: "fake",
        script: [
          {
            type: "tool",
            name: HARDWARE_TOOL_NAME,
            arguments: {
              commandId: "cmd-group",
              deviceId: "sim-host-led",
              operation: "actuate",
              deadlineMs: 1000,
              payload: null,
            },
          },
          { type: "text", text: "first" },
        ],
      },
    });
    await agent.run("one");
    const second = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory,
      execution: {
        async submit() {
          return { outcome: "confirmed", detail: "ok" };
        },
      },
      limits: { maxSessionMessages: 3 },
      provider: { kind: "fake", script: [{ type: "text", text: "second" }] },
    });
    await second.run("two");
    const saved = JSON.parse(readFileSync(second.sessionPath, "utf8")) as {
      messages: {
        role: string;
        toolCallId?: string;
        toolCalls?: { id: string }[];
      }[];
    };
    expect(saved.messages.length).toBeLessThanOrEqual(3);
    const calls = new Set(
      saved.messages.flatMap((message) =>
        (message.toolCalls ?? []).map((call) => call.id),
      ),
    );
    for (const message of saved.messages) {
      if (message.role === "tool") {
        expect(calls.has(message.toolCallId ?? "")).toBe(true);
      }
    }
  });

  it("measures the storage budget in bytes and round-trips non-ascii text", async () => {
    const sessionDirectory = mkdtempSync(
      path.join(tmpdir(), "november-session-"),
    );
    const text = "温度 ".repeat(200);
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory,
      execution: {
        async submit() {
          return { outcome: "confirmed", detail: "ok" };
        },
      },
      limits: { maxSessionBytes: 2_048 },
      provider: { kind: "fake", script: [{ type: "text", text }] },
    });
    const result = await agent.run(text);
    expect(result.status).toBe("completed");
    const reread = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory,
      execution: {
        async submit() {
          return { outcome: "confirmed", detail: "ok" };
        },
      },
      provider: { kind: "fake", script: [{ type: "text", text: "again" }] },
    });
    expect((await reread.run("next")).status).toBe("completed");
    const saved = readFileSync(reread.sessionPath, "utf8");
    expect(saved).toContain("温度");
  });
});
