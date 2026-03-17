import { Hono } from "hono";
import { runAgent } from "./agent.ts";
import { sessionService } from "./services/session.ts";
import { promptService } from "./services/prompt.ts";
import { log } from "./services/logger.ts";
import { assistants } from "./services/assistants.ts";
import { config } from "./config/index.ts";
import type { LLMMessage } from "./types/llm.ts";

const assistantName = config.assistant ?? "default";
const assistant = await assistants.get(assistantName);
const actPrompt = await promptService.load("act", {
  objective: assistant.objective,
  tone: assistant.tone,
});
const agentModel = assistant.model ?? actPrompt.model!;
const toolFilter = assistant.tools;

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

  if (!body || typeof body.msg !== "string") {
    return c.json(
      { error: "Body must contain sessionId/sessionID (string) and msg (string)" },
      400,
    );
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId
    : typeof body.sessionID === "string" ? body.sessionID
    : undefined;

  if (!sessionId) {
    return c.json(
      { error: "Body must contain sessionId or sessionID (string)" },
      400,
    );
  }

  const { msg } = body as { msg: string };

  try {
    const answer = await sessionService.enqueue(sessionId, async () => {
      const session = sessionService.getOrCreate(sessionId);

      // First interaction — prepend system prompt
      if (session.messages.length === 0) {
        sessionService.appendMessage(sessionId, {
          role: "system",
          content: actPrompt.content,
        });
      }

      sessionService.appendMessage(sessionId, { role: "user", content: msg });

      // Pass a copy so runAgent's pushes don't double-add to session
      const messages: LLMMessage[] = [...session.messages];
      const result = await runAgent(messages, undefined, {
        model: agentModel,
        sessionId,
        toolFilter,
      });

      // Persist the messages that runAgent appended (assistant + tool messages)
      const newMessages = messages.slice(session.messages.length);
      for (const m of newMessages) {
        sessionService.appendMessage(sessionId, m);
      }

      return result;
    });

    return c.json({ msg: answer });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
