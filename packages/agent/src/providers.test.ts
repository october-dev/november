import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
  headers: IncomingMessage["headers"];
  body: string;
}

function listen(
  handler: (body: string, response: ServerResponse, hits: number) => void,
): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ url: request.url ?? "", headers: request.headers, body });
      handler(body, response, requests.length);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise((done, reject) => {
            server.close((error) => (error ? reject(error) : done()));
          }),
      });
    });
  });
}

function textCompletion(text: string): string {
  return JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: text } }],
  });
}

const noHardware: ExecutionClient = {
  submit(request: HardwareRequest) {
    throw new Error(`unexpected hardware call ${request.commandId}`);
  },
};

describe("openai-compatible providers", () => {
  it("calls a hosted endpoint with an explicit key and does not store the key", async () => {
    const server = await listen((_body, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(textCompletion("hosted ok"));
    });
    try {
      const agent = createDeviceAgent({
        projectId: "bench",
        deviceId: "led",
        sessionDirectory: directory(),
        execution: noHardware,
        provider: {
          kind: "hosted-openai",
          baseUrl: server.url,
          model: "gpt-test",
          apiKey: "synthetic-test-key",
        },
      });
      const result = await agent.run("hello");
      expect(result.status).toBe("completed");
      expect(result.text).toBe("hosted ok");
      expect(server.requests).toHaveLength(1);
      const recorded = server.requests[0];
      expect(recorded?.url).toBe("/v1/chat/completions");
      expect(recorded?.headers.authorization).toBe("Bearer synthetic-test-key");
      const body = JSON.parse(recorded?.body ?? "{}") as {
        model: string;
        max_tokens: number;
        messages: { role: string }[];
      };
      expect(body.model).toBe("gpt-test");
      expect(body.max_tokens).toBeGreaterThan(0);
      expect(body.messages.some((message) => message.role === "system")).toBe(
        true,
      );
      expect(recorded?.body).not.toContain("synthetic-test-key");
      const saved = readFileSync(agent.sessionPath, "utf8");
      expect(saved).not.toContain("synthetic-test-key");
      expect(saved).toContain("hosted-openai");
    } finally {
      await server.close();
    }
  });

  it("calls a local endpoint without an account key", async () => {
    const server = await listen((_body, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(textCompletion("local ok"));
    });
    try {
      const agent = createDeviceAgent({
        projectId: "bench",
        deviceId: "led",
        sessionDirectory: directory(),
        execution: noHardware,
        provider: {
          kind: "local-openai",
          baseUrl: server.url,
          model: "local-test",
        },
      });
      const result = await agent.run("hello");
      expect(result.status).toBe("completed");
      expect(result.text).toBe("local ok");
      expect(server.requests[0]?.headers.authorization).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("retries transport failures and still submits hardware only once", async () => {
    const calls: HardwareRequest[] = [];
    const server = await listen((_body, response, hits) => {
      if (hits < 3) {
        response.writeHead(500);
        response.end("temporary");
        return;
      }
      if (hits > 3) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(textCompletion("after tool"));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-http",
                    type: "function",
                    function: {
                      name: "request_device_action",
                      arguments: JSON.stringify({
                        commandId: "cmd-http",
                        deviceId: "sim-host-led",
                        operation: "read",
                        deadlineMs: 500,
                        payload: null,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
    });
    const followUp = await listen((_body, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(textCompletion("after tool"));
    });
    try {
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
          baseUrl: server.url,
          model: "gpt-test",
          apiKey: "synthetic-test-key",
        },
      });
      const first = await agent.run("read");
      expect(first.hardwareSubmissions).toBe(1);
      expect(first.status).toBe("completed");
      expect(server.requests).toHaveLength(4);
      expect(calls).toHaveLength(1);

      agent.selectProvider({
        kind: "local-openai",
        baseUrl: followUp.url,
        model: "local-test",
      });
      const second = await agent.run("what happened");
      expect(second.status).toBe("completed");
      expect(second.hardwareSubmissions).toBe(0);
      expect(calls).toHaveLength(1);
      expect(agent.permissions.canEditPolicy).toBe(false);
    } finally {
      await server.close();
      await followUp.close();
    }
  });

  it("stops after the retry cap and redacts the key from the error", async () => {
    const server = await listen((_body, response) => {
      response.writeHead(502);
      response.end("bad gateway synthetic-test-key");
    });
    try {
      const agent = createDeviceAgent({
        projectId: "bench",
        deviceId: "led",
        sessionDirectory: directory(),
        execution: noHardware,
        limits: { maxRetries: 2 },
        provider: {
          kind: "hosted-openai",
          baseUrl: server.url,
          model: "gpt-test",
          apiKey: "synthetic-test-key",
        },
      });
      const result = await agent.run("hello");
      expect(result.status).toBe("failed");
      expect(server.requests).toHaveLength(3);
      expect(result.error).toContain("502");
      expect(result.error).not.toContain("synthetic-test-key");
      expect(result.error).toContain("[redacted]");
    } finally {
      await server.close();
    }
  });

  it("does not retry a rejected request", async () => {
    const server = await listen((_body, response) => {
      response.writeHead(401);
      response.end("unauthorized");
    });
    try {
      const agent = createDeviceAgent({
        projectId: "bench",
        deviceId: "led",
        sessionDirectory: directory(),
        execution: noHardware,
        provider: {
          kind: "hosted-openai",
          baseUrl: server.url,
          model: "gpt-test",
          apiKey: "synthetic-test-key",
        },
      });
      const result = await agent.run("hello");
      expect(result.status).toBe("failed");
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
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
    const server = await listen((_body, response) => {
      response.writeHead(200);
      response.end(textCompletion("should not run"));
    });
    try {
      expect(() =>
        createDeviceAgent({
          projectId: "bench",
          deviceId: "led",
          sessionDirectory: directory(),
          execution: noHardware,
          provider: {
            kind: "hosted-openai",
            baseUrl: server.url,
            model: "gpt-test",
            apiKey: " ",
          },
        }),
      ).toThrow(/api key/);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("does not follow redirects", async () => {
    const server = await listen((_body, response) => {
      response.writeHead(302, { location: "http://127.0.0.1/elsewhere" });
      response.end();
    });
    try {
      const agent = createDeviceAgent({
        projectId: "bench",
        deviceId: "led",
        sessionDirectory: directory(),
        execution: noHardware,
        limits: { maxRetries: 0 },
        provider: {
          kind: "local-openai",
          baseUrl: server.url,
          model: "local-test",
        },
      });
      const result = await agent.run("hello");
      expect(result.status).toBe("failed");
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
