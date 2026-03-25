import { describe, it, expect, beforeEach, mock } from "bun:test";
import { sessionService } from "./agent/session.ts";

// Mock the orchestrator — avoids polluting agent/loop.ts mock across test files
const KNOWN_AGENTS = ["default", "proxy"];
mock.module("./agent/orchestrator.ts", () => ({
  executeTurn: async (opts: { prompt: string; sessionId?: string; assistant?: string }) => {
    const sid = opts.sessionId ?? "auto";
    const assistantName = opts.assistant ?? "default";
    if (!KNOWN_AGENTS.includes(assistantName)) {
      throw new Error(`Unknown agent "${assistantName}". Available: ${KNOWN_AGENTS.join(", ")}`);
    }
    const session = sessionService.getOrCreate(sid);
    if (!session.assistant) session.assistant = assistantName;
    sessionService.appendMessage(sid, { role: "user", content: opts.prompt });
    sessionService.appendMessage(sid, { role: "assistant", content: "mock answer" });
    return { answer: "mock answer", sessionId: sid };
  },
}));

// Import after mock is set up
const { default: server } = await import("./server.ts");

function request(path: string, init?: RequestInit) {
  return server.fetch(
    new Request(`http://localhost${path}`, init),
  );
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

describe("POST /chat", () => {
  it("returns 400 when body is missing fields", async () => {
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });

  it("returns 400 when sessionId is not a string", async () => {
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: 123, msg: "hi" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns agent answer on valid request", async () => {
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", msg: "hello" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.msg).toBe("mock answer");
  });

  it("uses specified assistant from body", async () => {
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s-proxy", msg: "hello", assistant: "proxy" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.msg).toBe("mock answer");

    // Session should be pinned to "proxy"
    const session = sessionService.getOrCreate("s-proxy");
    expect(session.assistant).toBe("proxy");
  });

  it("returns 400 for unknown assistant with available names", async () => {
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s-bad", msg: "hi", assistant: "nonexistent" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Unknown agent");
    expect(json.error).toContain("nonexistent");
    expect(json.error).toContain("default");
  });

  it("pins assistant to session on first request", async () => {
    // First request with "proxy"
    await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s-pin", msg: "first", assistant: "proxy" }),
    });

    // Second request with different assistant — should be ignored
    await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s-pin", msg: "second", assistant: "default" }),
    });

    const session = sessionService.getOrCreate("s-pin");
    expect(session.assistant).toBe("proxy");
  });

  it("falls back to default assistant when not specified", async () => {
    await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s-default", msg: "hi" }),
    });

    const session = sessionService.getOrCreate("s-default");
    expect(session.assistant).toBe("default");
  });

  it("reuses session assistant when assistant field is omitted on subsequent requests", async () => {
    await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s-reuse", msg: "first", assistant: "proxy" }),
    });

    await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s-reuse", msg: "second" }),
    });

    const session = sessionService.getOrCreate("s-reuse");
    expect(session.assistant).toBe("proxy");
    // user + assistant + user + assistant = 4 (no system message stored)
    expect(session.messages.length).toBe(4);
  });

  it("ignores non-string assistant and falls back to default", async () => {
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s-nonstr", msg: "hi", assistant: 123 }),
    });
    expect(res.status).toBe(200);
    const session = sessionService.getOrCreate("s-nonstr");
    expect(session.assistant).toBe("default");
  });

  it("treats empty string assistant as unset and falls back to default", async () => {
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s-empty", msg: "hi", assistant: "" }),
    });
    expect(res.status).toBe(200);
    const session = sessionService.getOrCreate("s-empty");
    expect(session.assistant).toBe("default");
  });

  it("maintains session across requests", async () => {
    await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", msg: "first" }),
    });

    await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", msg: "second" }),
    });

    const messages = sessionService.getMessages("s1");
    // user("first") + assistant + user("second") + assistant = 4 (no system message)
    expect(messages.length).toBe(4);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("user");
    expect(messages[3].role).toBe("assistant");
  });
});
