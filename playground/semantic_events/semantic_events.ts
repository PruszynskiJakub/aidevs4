import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getHtmlTemplate } from "./ui.ts";
import { AgentEventEmitter } from "./event_emitter.ts";
import { runEventAgent } from "./event_agent.ts";
import type { AgentEvent } from "./types.ts";

const app = new Hono();
const sessions = new Map<string, AgentEventEmitter>();

let sessionCounter = 0;

function newSessionId(): string {
  return `session_${Date.now()}_${++sessionCounter}`;
}

// --- Routes ---

app.get("/", (c) => c.html(getHtmlTemplate()));

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/sessions", (c) => {
  const list = [];
  for (const [id, emitter] of sessions) {
    const buf = emitter.getBuffer();
    const last = buf[buf.length - 1];
    const ended = last?.type === "session_end";
    const hasPending = buf.some(
      (e) => e.type === "approval_request" &&
        !buf.some((r) => r.type === "approval_response" && (r as any).requestId === (e as any).requestId)
    );
    list.push({ id, ended, hasPendingApproval: hasPending, eventCount: buf.length });
  }
  return c.json({ sessions: list });
});

app.post("/chat", async (c) => {
  const body = await c.req.json<{ prompt?: string }>();
  const prompt = body?.prompt?.trim();
  if (!prompt) {
    return c.json({ error: "prompt is required" }, 400);
  }

  const sessionId = newSessionId();
  const emitter = new AgentEventEmitter();
  sessions.set(sessionId, emitter);

  // Run agent in background — don't await
  runEventAgent(sessionId, prompt, emitter).finally(() => {
    // Clean up finished sessions after 1 hour
    setTimeout(() => sessions.delete(sessionId), 60 * 60 * 1000);
  });

  return c.json({ sessionId });
});

app.post("/approve/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const emitter = sessions.get(sessionId);
  if (!emitter) {
    return c.json({ error: "session not found" }, 404);
  }

  const body = await c.req.json<{ requestId?: string; approved?: boolean }>();
  if (!body?.requestId || typeof body.approved !== "boolean") {
    return c.json({ error: "requestId and approved (boolean) are required" }, 400);
  }

  const resolved = emitter.resolveApproval(body.requestId, body.approved);
  if (!resolved) {
    return c.json({ error: "no pending approval with that requestId" }, 404);
  }

  return c.json({ status: "ok" });
});

app.get("/events/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const emitter = sessions.get(sessionId);

  if (!emitter) {
    return c.json({ error: "session not found" }, 404);
  }

  return streamSSE(c, async (stream) => {
    let closed = false;

    const listener = (event: AgentEvent) => {
      if (closed) return;
      stream.writeSSE({
        event: "agent_event",
        data: JSON.stringify(event),
        id: event.id,
      }).catch(() => { closed = true; });
    };

    // Subscribe — replays buffer then streams live
    emitter.on(listener);

    // Heartbeat to prevent connection timeout during long LLM calls
    const heartbeat = setInterval(() => {
      if (closed) return;
      stream.writeSSE({
        event: "heartbeat",
        data: "",
      }).catch(() => { closed = true; });
    }, 5000);

    // Keep stream open until session ends or client disconnects
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const buf = emitter.getBuffer();
        const last = buf[buf.length - 1];
        if (last?.type === "session_end" || closed) {
          clearInterval(check);
          resolve();
        }
      }, 200);

      stream.onAbort(() => {
        closed = true;
        clearInterval(check);
        resolve();
      });
    });

    clearInterval(heartbeat);
    emitter.off(listener);
  });
});

// --- Start ---

const PORT = 3001;
console.log(`Semantic Events UI: http://localhost:${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
