import { describe, it, expect, beforeEach, mock } from "bun:test";
import { sessionService } from "./services/session.ts";

// Mock runAgent before importing server
mock.module("./agent.ts", () => ({
  runAgent: async (messages: unknown[]) => {
    // Simulate agent appending an assistant message
    (messages as unknown[]).push({
      role: "assistant",
      content: "mock answer",
    });
    return "mock answer";
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
    // system + user("first") + assistant + user("second") + assistant
    expect(messages.length).toBe(5);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[2].role).toBe("assistant");
    expect(messages[3].role).toBe("user");
    expect(messages[4].role).toBe("assistant");
  });
});
