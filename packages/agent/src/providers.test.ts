import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDeviceAgent,
  type ExecutionClient,
  type HardwareRequest,
} from "./index.js";

function directory(): string {
  return mkdtempSync(path.join(tmpdir(), "november-provider-"));
}

interface Recorded {
  url: string;
  init: RequestInit | undefined;
  body: string;
}

function stubFetch(
  handler: (body: string, hits: number) => Response | Promise<Response>,
): typeof fetch & { requests: Recorded[] } {
  const requests: Recorded[] = [];
  const stub = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const body =
      typeof init?.body === "string" ? init.body : JSON.stringify(init?.body);
    requests.push({ url, init, body });
    return handler(body, requests.length);
  }) as typeof fetch & { requests: Recorded[] };
  stub.requests = requests;
  return stub;
}

function sseChunk(delta: object, finishReason: string | null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function sseText(text: string, finish = "stop"): string {
  return (
    sseChunk({ role: "assistant", content: text }, null) +
    sseChunk({}, finish) +
    "data: [DONE]\n\n"
  );
}

function sseToolCalls(
  calls: Array<{ id: string; name: string; args: unknown }>,
  text = "",
  finish = "tool_calls",
): string {
  const toolCalls = calls.map((call, index) => ({
    index,
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  return (
    sseChunk(
      { role: "assistant", content: text, tool_calls: toolCalls },
      null,
    ) +
    sseChunk({}, finish) +
    "data: [DONE]\n\n"
  );
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function deviceArgs(commandId: string): Record<string, unknown> {
  return {
    commandId,
    deviceId: "sim-host-led",
    operation: "read",
    deadlineMs: 500,
    payload: null,
  };
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

const noHardware: ExecutionClient = {
  submit(request: HardwareRequest) {
    throw new Error(`unexpected hardware call ${request.commandId}`);
  },
};

describe("openai-compatible providers", () => {
  it("calls a hosted endpoint with an explicit key and does not store the key", async () => {
    const fetch = stubFetch(() => sseResponse(sseText("hosted ok")));
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: noHardware,
      provider: {
        kind: "hosted-openai",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-test",
        apiKey: "synthetic-test-key",
        fetch,
      },
    });
    const result = await agent.run("hello");
    expect(result.status).toBe("completed");
    expect(result.text).toBe("hosted ok");
    expect(fetch.requests).toHaveLength(1);
    const recorded = fetch.requests[0];
    expect(recorded?.url).toBe(
      "https://models.example.com/v1/chat/completions",
    );
    expect(headersOf(recorded?.init).get("authorization")).toBe(
      "Bearer synthetic-test-key",
    );
    expect(headersOf(recorded?.init).get("user-agent")).toBe("november");
    expect(recorded?.init?.redirect).toBe("error");
    const body = JSON.parse(recorded?.body ?? "{}") as {
      model: string;
      max_completion_tokens: number;
      messages: { role: string }[];
    };
    expect(body.model).toBe("gpt-test");
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body.messages.some((message) => message.role === "system")).toBe(
      true,
    );
    expect(recorded?.body).not.toContain("synthetic-test-key");
    const saved = readFileSync(agent.sessionPath, "utf8");
    expect(saved).not.toContain("synthetic-test-key");
  });

  it("calls a local endpoint without an account key and keeps it keyless", async () => {
    const fetch = stubFetch(() => sseResponse(sseText("local ok")));
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: noHardware,
      provider: {
        kind: "local-openai",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-test",
        apiKey: "",
        fetch,
      },
    });
    const result = await agent.run("hello");
    expect(result.status).toBe("completed");
    expect(result.text).toBe("local ok");
    expect(fetch.requests).toHaveLength(1);
    expect(headersOf(fetch.requests[0]?.init).get("authorization")).toBeNull();
    expect(fetch.requests[0]?.url).toBe(
      "http://127.0.0.1:8080/v1/chat/completions",
    );
    const body = JSON.parse(fetch.requests[0]?.body ?? "{}") as {
      max_tokens?: number;
      max_completion_tokens?: number;
    };
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("sends the configured token field and namespaced model ids", async () => {
    const fetch = stubFetch(() => sseResponse(sseText("compat ok")));
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: noHardware,
      provider: {
        kind: "local-openai",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "openai/gpt-oss-120b",
        tokenField: "max_completion_tokens",
        fetch,
      },
    });
    const result = await agent.run("hello");
    expect(result.status).toBe("completed");
    const body = JSON.parse(fetch.requests[0]?.body ?? "{}") as {
      model: string;
      max_tokens?: number;
      max_completion_tokens?: number;
    };
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body.max_tokens).toBeUndefined();
    expect(() =>
      createDeviceAgent({
        projectId: "bench",
        deviceId: "led",
        sessionDirectory: directory(),
        execution: noHardware,
        provider: {
          kind: "local-openai",
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "",
        },
      }),
    ).toThrow(/nonempty/);
  });

  it("leaves the hosted token field to Pi's per-endpoint detection", async () => {
    const fetch = stubFetch(() => sseResponse(sseText("hosted ok")));
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: noHardware,
      provider: {
        kind: "hosted-openai",
        baseUrl: "https://api.together.xyz/v1",
        model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        apiKey: "synthetic-test-key",
        fetch,
      },
    });
    const result = await agent.run("hello");
    expect(result.status).toBe("completed");
    const body = JSON.parse(fetch.requests[0]?.body ?? "{}") as {
      max_tokens?: number;
      max_completion_tokens?: number;
    };
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("forwards accompanying text with multiple tool calls", async () => {
    const calls: HardwareRequest[] = [];
    const fetch = stubFetch((_body, hits) => {
      if (hits === 1) {
        return sseResponse(
          sseToolCalls(
            [
              {
                id: "call-1",
                name: "request_device_action",
                args: deviceArgs("cmd-a"),
              },
              {
                id: "call-2",
                name: "request_device_action",
                args: deviceArgs("cmd-b"),
              },
            ],
            "two actions",
          ),
        );
      }
      return sseResponse(sseText("done"));
    });
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: {
        async submit(request) {
          calls.push(request);
          return { outcome: "rejected", detail: "sim" };
        },
      },
      provider: {
        kind: "local-openai",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-test",
        fetch,
      },
    });
    const result = await agent.run("go");
    expect(result.status).toBe("completed");
    expect(calls.map((call) => call.commandId).sort()).toEqual([
      "cmd-a",
      "cmd-b",
    ]);
    expect(result.text).toContain("done");
  });

  it("never executes tool calls from a length-truncated reply", async () => {
    const calls: HardwareRequest[] = [];
    const fetch = stubFetch(() =>
      sseResponse(
        sseToolCalls(
          [
            {
              id: "call-truncated",
              name: "request_device_action",
              args: deviceArgs("cmd-truncated"),
            },
          ],
          "",
          "length",
        ),
      ),
    );
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: {
        async submit(request) {
          calls.push(request);
          return { outcome: "rejected", detail: "sim" };
        },
      },
      provider: {
        kind: "local-openai",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-test",
        fetch,
      },
    });
    await agent.run("go");
    expect(calls).toEqual([]);
  });

  it("fails empty and malformed completions instead of succeeding", async () => {
    for (const body of ["{}", '{"choices":[]}', "not json"]) {
      const fetch = stubFetch(
        () =>
          new Response(`data: ${body}\n\ndata: [DONE]\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const agent = createDeviceAgent({
        projectId: "bench",
        deviceId: "led",
        sessionDirectory: directory(),
        execution: noHardware,
        provider: {
          kind: "local-openai",
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "local-test",
          fetch,
        },
      });
      const result = await agent.run("hello");
      expect(result.status, body).toBe("failed");
      expect(result.error, body).toBeTruthy();
    }
  });

  it("retries transport failures and still submits hardware only once", async () => {
    const calls: HardwareRequest[] = [];
    const fetch = stubFetch((_body, hits) => {
      if (hits < 3) {
        return new Response("temporary", { status: 500 });
      }
      if (hits > 3) {
        return sseResponse(sseText("after tool"));
      }
      return sseResponse(
        sseToolCalls([
          {
            id: "call-http",
            name: "request_device_action",
            args: deviceArgs("cmd-http"),
          },
        ]),
      );
    });
    const followUp = stubFetch(() => sseResponse(sseText("after tool")));
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: {
        async submit(request) {
          calls.push(request);
          return { outcome: "rejected", detail: "sim" };
        },
      },
      limits: { maxRetries: 2 },
      provider: {
        kind: "hosted-openai",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-test",
        apiKey: "synthetic-test-key",
        fetch,
      },
    });
    const first = await agent.run("read");
    expect(first.hardwareSubmissions).toBe(1);
    expect(first.status).toBe("completed");
    expect(fetch.requests).toHaveLength(4);
    expect(calls).toHaveLength(1);

    agent.selectProvider({
      kind: "local-openai",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "local-test",
      fetch: followUp,
    });
    const second = await agent.run("what happened");
    expect(second.status).toBe("completed");
    expect(second.hardwareSubmissions).toBe(0);
    expect(calls).toHaveLength(1);
    expect(agent.permissions.canEditPolicy).toBe(false);
  });

  it("honors retry delays and stops after the retry cap with the key redacted", async () => {
    const fetch = stubFetch((_body, hits) => {
      if (hits === 1) {
        return new Response("slow down", {
          status: 429,
          headers: { "retry-after-ms": "300" },
        });
      }
      return sseResponse(sseText("recovered"));
    });
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: noHardware,
      provider: {
        kind: "hosted-openai",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-test",
        apiKey: "synthetic-test-key",
        fetch,
      },
    });
    const started = Date.now();
    const result = await agent.run("hello");
    expect(result.status).toBe("completed");
    expect(fetch.requests).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);

    const failing = stubFetch(
      () => new Response("bad gateway synthetic-test-key", { status: 502 }),
    );
    const capped = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: noHardware,
      limits: { maxRetries: 2 },
      provider: {
        kind: "hosted-openai",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-test",
        apiKey: "synthetic-test-key",
        fetch: failing,
      },
    });
    const cappedResult = await capped.run("hello");
    expect(cappedResult.status).toBe("failed");
    expect(failing.requests).toHaveLength(3);
    expect(cappedResult.error).toContain("502");
    expect(cappedResult.error).not.toContain("synthetic-test-key");
    expect(cappedResult.error).toContain("[redacted]");
  });

  it("cancels a run waiting on a retry delay", async () => {
    const fetch = stubFetch(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after-ms": "5000" },
        }),
    );
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: noHardware,
      provider: {
        kind: "hosted-openai",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-test",
        apiKey: "synthetic-test-key",
        fetch,
      },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await agent.run("hello", { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("times out headers followed by a stalled body", async () => {
    const fetch = stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start() {
              // Never enqueue or close: the body stalls after headers.
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: noHardware,
      limits: { requestTimeoutMs: 300 },
      provider: {
        kind: "local-openai",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-test",
        fetch,
      },
    });
    const started = Date.now();
    const result = await agent.run("hello");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("model request timed out");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("caps the response body it will buffer", async () => {
    const fetch = stubFetch(() => sseResponse(sseText("x".repeat(10_000))));
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: noHardware,
      limits: { maxResponseBytes: 100 },
      provider: {
        kind: "local-openai",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-test",
        fetch,
      },
    });
    const result = await agent.run("hello");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("byte cap");
  });

  it("recovers after a failed turn without replaying it, before and after restart", async () => {
    let fail = true;
    const fetch = stubFetch(() => {
      if (fail) {
        return new Response("temporary", { status: 500 });
      }
      return sseResponse(sseText("recovered"));
    });
    const sessionDirectory = directory();
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory,
      execution: noHardware,
      limits: { maxRetries: 0 },
      provider: {
        kind: "local-openai",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-test",
        fetch,
      },
    });
    const first = await agent.run("hello");
    expect(first.status).toBe("failed");
    const saved = JSON.parse(readFileSync(agent.sessionPath, "utf8")) as {
      messages: { role: string }[];
    };
    expect(saved.messages.map((message) => message.role)).toEqual(["user"]);

    fail = false;
    const second = await agent.run("again");
    expect(second.status).toBe("completed");

    const restarted = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory,
      execution: noHardware,
      limits: { maxRetries: 0 },
      provider: {
        kind: "local-openai",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-test",
        fetch,
      },
    });
    const third = await restarted.run("once more");
    expect(third.status).toBe("completed");
  });

  it("does not retry a rejected request", async () => {
    const fetch = stubFetch(
      () => new Response("unauthorized", { status: 401 }),
    );
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: noHardware,
      provider: {
        kind: "hosted-openai",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-test",
        apiKey: "synthetic-test-key",
        fetch,
      },
    });
    const result = await agent.run("hello");
    expect(result.status).toBe("failed");
    expect(fetch.requests).toHaveLength(1);
  });

  it("rejects a cleartext hosted endpoint that is not loopback", () => {
    expect(() =>
      createDeviceAgent({
        projectId: "bench",
        deviceId: "led",
        sessionDirectory: directory(),
        execution: noHardware,
        provider: {
          kind: "hosted-openai",
          baseUrl: "http://example.com",
          model: "gpt-test",
          apiKey: "synthetic-test-key",
        },
      }),
    ).toThrow(/https/);
  });

  it("rejects a hosted provider with no key before any request", async () => {
    const fetch = stubFetch(() => sseResponse(sseText("should not run")));
    expect(() =>
      createDeviceAgent({
        projectId: "bench",
        deviceId: "led",
        sessionDirectory: directory(),
        execution: noHardware,
        provider: {
          kind: "hosted-openai",
          baseUrl: "https://models.example.com/v1",
          model: "gpt-test",
          apiKey: " ",
          fetch,
        },
      }),
    ).toThrow(/api key/);
    expect(fetch.requests).toHaveLength(0);
  });

  it("refuses redirects without sending a second request", async () => {
    const seen: unknown[] = [];
    const inner = stubFetch(() => {
      throw new Error("redirects are refused");
    });
    const agent = createDeviceAgent({
      projectId: "bench",
      deviceId: "led",
      sessionDirectory: directory(),
      execution: noHardware,
      limits: { maxRetries: 0 },
      provider: {
        kind: "local-openai",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-test",
        fetch: (async (input, init) => {
          seen.push(init?.redirect);
          return inner(input, init);
        }) as typeof fetch,
      },
    });
    const result = await agent.run("hello");
    expect(result.status).toBe("failed");
    expect(seen).toEqual(["error"]);
  });
});
