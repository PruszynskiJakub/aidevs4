import { Hono } from "hono";
import { runAgent } from "./agent.ts";
import { sessionService } from "./services/session.ts";
import { promptService } from "./services/prompt.ts";
import { log } from "./services/logger.ts";
import type { LLMMessage } from "./types/llm.ts";

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => null);

  if (
    !body ||
    typeof body.sessionId !== "string" ||
    typeof body.msg !== "string"
  ) {
    return c.json(
      { error: "Body must contain sessionId (string) and msg (string)" },
      400,
    );
  }

  const { sessionId, msg } = body as { sessionId: string; msg: string };

  try {
    const answer = await sessionService.enqueue(sessionId, async () => {
      const session = sessionService.getOrCreate(sessionId);

      // First interaction — prepend system prompt
      if (session.messages.length === 0) {
        const system = await promptService.load("system");
        sessionService.appendMessage(sessionId, {
          role: "system",
          content: system.content,
        });
      }

      sessionService.appendMessage(sessionId, { role: "user", content: msg });

      // Pass a copy so runAgent's pushes don't double-add to session
      const messages: LLMMessage[] = [...session.messages];
      const result = await runAgent(messages);

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

const port = Number(process.env.PORT) || 3000;

export default {
  fetch: app.fetch,
  port,
};

log.info(`Server listening on http://localhost:${port}`);
