import { Hono } from "hono";
import { sessionService } from "./services/agent/session.ts";
import { executeTurn } from "./services/agent/orchestrator.ts";
import { log } from "./services/common/logging/logger.ts";
import { config } from "./config/index.ts";

interface ChatRequest {
  sessionId: string;
  msg: string;
  requestedAssistant?: string;
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

  return { sessionId, msg: b.msg as string, requestedAssistant };
}

const app = new Hono();

app.use("*", async (c, next) => {
  const start = performance.now();
  await next();
  const ms = (performance.now() - start).toFixed(0);
  log.info(`${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = parseChatBody(body);

  if ("error" in parsed) {
    return c.json({ error: parsed.error }, 400);
  }

  const { sessionId, msg, requestedAssistant } = parsed;

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
    const isClientError = message.includes("Unknown assistant");
    if (isClientError) {
      return c.json({ error: message }, 400);
    }
    log.error(`/chat error [${sessionId}]: ${message}`);
    return c.json({ error: message }, 500);
  }
});

const port = config.server.port;

export default {
  fetch: app.fetch,
  port,
};

log.info(`Server listening on http://localhost:${port}`);
