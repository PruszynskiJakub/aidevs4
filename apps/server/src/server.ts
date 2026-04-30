import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { executeRun, type ExecuteRunResult } from "./agent/orchestrator.ts";
import { foldExit } from "./agent/run-exit.ts";
import { resumeRun } from "./agent/resume-run.ts";
import { log } from "./infra/log/logger.ts";
import { config } from "./config/index.ts";
import { initServices, installSignalHandlers } from "./infra/bootstrap.ts";
import { createRuntime } from "./runtime.ts";
import { isDomainError, toHttpStatus } from "./types/errors.ts";

/**
 * Convert a thrown error into a sanitized HTTP response payload.
 * - DomainError: log internalMessage, return { type, message } with mapped status.
 * - Unknown error: log full message, return generic 500 (no leakage).
 */
function errorToHttpPayload(
  err: unknown,
  logPrefix: string,
): { status: number; body: { error: { type: string; message: string } } } {
  if (isDomainError(err)) {
    if (err.internalMessage) {
      log.error(`${logPrefix} (${err.type}): ${err.internalMessage}`);
    }
    return {
      status: toHttpStatus(err.type),
      body: { error: { type: err.type, message: err.message } },
    };
  }
  const internal = err instanceof Error ? err.message : String(err);
  log.error(`${logPrefix} (unhandled): ${internal}`);
  return {
    status: 500,
    body: { error: { type: "provider", message: "Internal error" } },
  };
}

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

// Composition root — built once at boot, shared across all request handlers.
const runtime = createRuntime();

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

app.post("/api/negotiations/search", async (c) => {
  const body = await c.req.json().catch(() => null);
  const params = (body as Record<string, unknown> | null)?.params;
  if (!params || typeof params !== "string") {
    return c.json({ output: "Error: params field required" }, 400);
  }

  try {
    const { exit } = await executeRun({
      prompt: params,
      assistant: "negotiations",
    }, runtime);

    const answer = exit.kind === "completed" ? exit.result : "";
    const encoded = new TextEncoder().encode(answer);
    const output = new TextDecoder().decode(encoded.slice(0, 500));
    return c.json({ output });
  } catch (err) {
    const { status } = errorToHttpPayload(err, "/api/negotiations/search error");
    // This route's contract returns { output } not { error } — preserve that shape.
    return c.json({ output: "Error: search failed" }, status);
  }
});

function exitToPayload(result: ExecuteRunResult): Record<string, unknown> {
  const { exit, runId, sessionId } = result;
  return foldExit<Record<string, unknown>>(exit, {
    completed: (answer) => ({ kind: "completed", runId, sessionId, answer }),
    failed: (error) => ({ kind: "failed", runId, sessionId, error }),
    cancelled: (reason) => ({ kind: "cancelled", runId, sessionId, reason }),
    exhausted: (cycleCount) => ({ kind: "exhausted", runId, sessionId, cycleCount }),
    waiting: (waitingOn) => ({ kind: "waiting", runId, sessionId, waitingOn }),
  });
}

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

      const unsubscribe = runtime.bus.onAny((event) => {
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
        const result = await runtime.sessions.enqueue(sessionId, () =>
          executeRun({
            sessionId,
            prompt: msg,
            assistant: requestedAssistant,
          }, runtime),
        );
        if (!closed) {
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify(exitToPayload(result)),
          });
        }
      } catch (err) {
        if (!closed) {
          const { body } = errorToHttpPayload(err, `/chat (stream) [${sessionId}]`);
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify(body),
          });
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  }

  try {
    const result = await runtime.sessions.enqueue(sessionId, () =>
      executeRun({
        sessionId,
        prompt: msg,
        assistant: requestedAssistant,
      }, runtime),
    );
    const payload = exitToPayload(result);
    if (result.exit.kind === "completed") {
      return c.json({ msg: result.exit.result, ...payload });
    }
    return c.json(payload);
  } catch (err) {
    const { status, body } = errorToHttpPayload(err, `/chat error [${sessionId}]`);
    return c.json(body, status as any);
  }
});

/**
 * POST /resume — supplies a WaitResolution for a waiting run and
 * streams the subsequent exit via SSE.
 */
app.post("/resume", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const runId = typeof body?.runId === "string" ? body.runId : undefined;
  const resolution = body?.resolution as Record<string, unknown> | undefined;

  if (!runId || !resolution || typeof resolution.kind !== "string") {
    return c.json({ error: "Body must contain { runId, resolution: { kind, ... } }" }, 400);
  }

  return streamSSE(c, async (stream) => {
    let closed = false;
    stream.onAbort(() => { closed = true; });

    try {
      const result = await resumeRun(runId, resolution as any, runtime);
      if (!closed) {
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify(exitToPayload(result)),
        });
      }
    } catch (err) {
      if (!closed) {
        const { body } = errorToHttpPayload(err, `/resume error [${runId}]`);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify(body),
        });
      }
    }
  });
});

await initServices();
installSignalHandlers();

const port = config.server.port;

export default {
  fetch: app.fetch,
  port,
};

log.info(`Server listening on http://localhost:${port}`);
