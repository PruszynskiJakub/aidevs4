import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sessionService } from "./agent/session.ts";
import { executeTurn } from "./agent/orchestrator.ts";
import { log } from "./infra/log/logger.ts";
import { config } from "./config/index.ts";
import { bus } from "./infra/events.ts";
import { initServices, installSignalHandlers } from "./infra/bootstrap.ts";
import { setConfirmationProvider } from "./agent/confirmation.ts";
import type { Decision } from "./types/tool.ts";
import { requireState } from "./agent/context.ts";

interface ChatRequest {
  sessionId: string;
  msg: string;
  requestedAssistant?: string;
  stream?: boolean;
}

function parseChatBody(body: unknown): ChatRequest | { error: string } {
  if (!body || typeof (body as Record<string, unknown>).msg !== "string") {
    return { error: "Body must contain sessionId/sessionID (string) and msg (string)" };
  }

  const b = body as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId
    : typeof b.sessionID === "string" ? b.sessionID
    : undefined;

  if (!sessionId) {
    return { error: "Body must contain sessionId or sessionID (string)" };
  }

  const requestedAssistant = typeof b.assistant === "string" && b.assistant !== ""
    ? b.assistant
    : undefined;

  const stream = b.stream === true;

  return { sessionId, msg: b.msg as string, requestedAssistant, stream };
}

/**
 * Parse a comma-separated event type filter from query string.
 * Returns null if no filter is specified (= send all events).
 */
function parseEventFilter(query: string | undefined): Set<string> | null {
  if (!query || query.trim() === "") return null;
  const types = query.split(",").map((s) => s.trim()).filter(Boolean);
  return types.length > 0 ? new Set(types) : null;
}

const app = new Hono();

app.use("*", async (c, next) => {
  const start = performance.now();
  await next();
  const ms = (performance.now() - start).toFixed(0);
  log.info(`${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/chat", async (c, next) => {
  const secret = config.server.apiSecret;
  if (!secret) return await next();

  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (token !== secret) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// ── Confirmation gate (HTTP) ─────────────────────────────────

const pendingConfirmations = new Map<string, {
  resolve: (decisions: Map<string, Decision>) => void;
  timeout: Timer;
}>();

function resolvePending(
  sessionId: string,
  decisions: Map<string, Decision>,
): void {
  const pending = pendingConfirmations.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingConfirmations.delete(sessionId);
  pending.resolve(decisions);
}

setConfirmationProvider({
  async confirm(requests) {
    const { sessionId } = requireState();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const denied = new Map(requests.map((r) => [r.toolCallId, "deny" as const]));
        resolvePending(sessionId, denied);
      }, 120_000);

      pendingConfirmations.set(sessionId, { resolve, timeout });
    });
  },
});

app.post("/chat/:sessionId/confirm", async (c) => {
  const { sessionId } = c.req.param();
  const pending = pendingConfirmations.get(sessionId);
  if (!pending) {
    return c.json({ error: "No pending confirmation for this session" }, 404);
  }

  const body = await c.req.json();
  const raw = Object.entries((body as Record<string, unknown>).decisions ?? {});
  const decisions = new Map<string, Decision>(
    raw.map(([id, v]) => [id, v === "approve" ? "approve" : "deny"]),
  );
  resolvePending(sessionId, decisions);

  return c.json({ status: "ok" });
});

for (const evt of ["session.completed", "session.failed"] as const) {
  bus.on(evt, (e) => {
    if (e.sessionId && pendingConfirmations.has(e.sessionId)) {
      resolvePending(e.sessionId, new Map());
    }
  });
}

app.post("/api/negotiations/search", async (c) => {
  const body = await c.req.json().catch(() => null);
  const params = (body as Record<string, unknown> | null)?.params;
  if (!params || typeof params !== "string") {
    return c.json({ output: "Error: params field required" }, 400);
  }

  try {
    const { answer } = await executeTurn({
      prompt: params,
      assistant: "negotiations",
    });

    const encoded = new TextEncoder().encode(answer);
    const output = new TextDecoder().decode(encoded.slice(0, 500));
    return c.json({ output });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`/api/negotiations/search error: ${message}`);
    return c.json({ output: "Error: search failed" }, 500);
  }
});

app.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = parseChatBody(body);

  if ("error" in parsed) {
    return c.json({ error: parsed.error }, 400);
  }

  const { sessionId, msg, requestedAssistant, stream: wantsStream } = parsed;

  c.header("X-Session-Id", sessionId);
  c.header("Access-Control-Expose-Headers", "X-Session-Id");

  if (wantsStream) {
    const allowedEvents = parseEventFilter(c.req.query("events"));

    return streamSSE(c, async (stream) => {
      let closed = false;

      const unsubscribe = bus.onAny((event) => {
        if (closed) return;
        if (event.sessionId !== sessionId) return;
        if (allowedEvents && !allowedEvents.has(event.type)) return;

        stream.writeSSE({
          event: "agent_event",
          data: JSON.stringify(event),
          id: event.id,
        }).catch(() => { closed = true; });
      });

      const heartbeat = setInterval(() => {
        if (closed) return;
        stream.writeSSE({ event: "heartbeat", data: "" })
          .catch(() => { closed = true; });
      }, 15_000);

      stream.onAbort(() => { closed = true; });

      try {
        const { answer } = await sessionService.enqueue(sessionId, () =>
          executeTurn({
            sessionId,
            prompt: msg,
            assistant: requestedAssistant,
          }),
        );
        if (!closed) {
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify({ answer }),
          });
        }
      } catch (err) {
        if (!closed) {
          const message = err instanceof Error ? err.message : String(err);
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: message }),
          });
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  }

  try {
    const { answer } = await sessionService.enqueue(sessionId, () =>
      executeTurn({
        sessionId,
        prompt: msg,
        assistant: requestedAssistant,
      }),
    );
    return c.json({ msg: answer });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isClientError = message.includes("Unknown agent");
    if (isClientError) {
      return c.json({ error: message }, 400);
    }
    log.error(`/chat error [${sessionId}]: ${message}`);
    return c.json({ error: message }, 500);
  }
});

await initServices();
installSignalHandlers();

const port = config.server.port;

export default {
  fetch: app.fetch,
  port,
};

log.info(`Server listening on http://localhost:${port}`);
