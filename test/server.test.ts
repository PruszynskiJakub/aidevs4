import { describe, it, expect, beforeEach } from "bun:test";
import { sessionService } from "../src/agent/session.ts";
import { config } from "../src/config/index.ts";
import { llm } from "../src/llm/llm.ts";
import type { LLMChatResponse } from "../src/types/llm.ts";
import * as dbOps from "../src/infra/db/index.ts";

// Install a stub LLM provider by monkey-patching the singleton — this
// avoids `mock.module` on `./agent/orchestrator.ts`, which would leak
// to other test files in the same bun-test process and break tests
// that rely on the real orchestrator (e.g. run-exit.test.ts).
(llm as unknown as {
  chatCompletion: (...args: unknown[]) => Promise<LLMChatResponse>;
}).chatCompletion = async () => ({
  content: "mock answer",
  finishReason: "stop",
  toolCalls: [],
});

// Import after the LLM is stubbed so server.ts sees the patched singleton.
const { default: server } = await import("../src/server.ts");

/** Build auth headers if API_SECRET is configured. */
function authHeaders(): Record<string, string> {
  const secret = config.server.apiSecret;
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

function request(path: string, init?: RequestInit) {
  return server.fetch(
    new Request(`http://localhost${path}`, init),
  );
}

/** POST JSON to /chat with auth headers included. */
function chatRequest(body: Record<string, unknown>) {
  return request("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sessionService._clear();
});

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /chat — auth", () => {
  it("returns 401 when API_SECRET is set and no auth header provided", async () => {
    if (!config.server.apiSecret) return; // skip if no secret configured
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", msg: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when Bearer token is wrong", async () => {
    if (!config.server.apiSecret) return;
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify({ sessionId: "s1", msg: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("passes auth with correct Bearer token", async () => {
    const res = await chatRequest({ sessionId: "s-auth", msg: "hi" });
    expect(res.status).toBe(200);
  });
});

describe("POST /chat", () => {
  it("returns 400 when body is missing fields", async () => {
    const res = await chatRequest({});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });

  it("returns 400 when sessionId is not a string", async () => {
    const res = await chatRequest({ sessionId: 123, msg: "hi" });
    expect(res.status).toBe(400);
  });

  it("returns agent answer on valid request", async () => {
    const res = await chatRequest({ sessionId: "s1", msg: "hello" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.msg).toBe("mock answer");
  });

  it("uses specified assistant from body", async () => {
    const res = await chatRequest({ sessionId: "s-proxy", msg: "hello", assistant: "proxy" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.msg).toBe("mock answer");

    const session = sessionService.getOrCreate("s-proxy");
    expect(session.assistant).toBe("proxy");
  });

  it("returns 400 for unknown assistant with available names", async () => {
    const res = await chatRequest({ sessionId: "s-bad", msg: "hi", assistant: "nonexistent" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Unknown agent");
  });

  it("pins assistant to session on first request", async () => {
    await chatRequest({ sessionId: "s-pin", msg: "first", assistant: "proxy" });
    await chatRequest({ sessionId: "s-pin", msg: "second", assistant: "default" });

    const session = sessionService.getOrCreate("s-pin");
    expect(session.assistant).toBe("proxy");
  });

  it("falls back to default assistant when not specified", async () => {
    await chatRequest({ sessionId: "s-default", msg: "hi" });

    const session = sessionService.getOrCreate("s-default");
    expect(session.assistant).toBe("default");
  });

  it("ignores non-string assistant and falls back to default", async () => {
    const res = await chatRequest({ sessionId: "s-nonstr", msg: "hi", assistant: 123 });
    expect(res.status).toBe(200);
    const session = sessionService.getOrCreate("s-nonstr");
    expect(session.assistant).toBe("default");
  });

  it("treats empty string assistant as unset and falls back to default", async () => {
    const res = await chatRequest({ sessionId: "s-empty", msg: "hi", assistant: "" });
    expect(res.status).toBe(200);
    const session = sessionService.getOrCreate("s-empty");
    expect(session.assistant).toBe("default");
  });
});

describe("POST /resume", () => {
  it("returns 400 when body is missing runId or resolution", async () => {
    const res = await request("/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
