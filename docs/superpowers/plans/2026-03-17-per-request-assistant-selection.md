# SP-31 Per-Request Assistant Selection — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `/chat` callers to specify which assistant to use via `body.assistant`, resolving prompt/model/tools per-request instead of at startup.

**Architecture:** Remove the module-level assistant resolution from `server.ts`. Add an `assistant` field to Session to pin the assistant on first message. Resolve assistant config, prompt, model, and tool filter inside the `/chat` handler on each request, caching rendered prompts by assistant name. The existing `assistants.get()` error already includes available names, so we let it propagate directly for 400 responses.

**Note:** Server tests are integration tests that hit real assistant YAML files and prompt templates on disk. This is consistent with the existing test approach in `server.test.ts`.

**Tech Stack:** Bun, TypeScript, Hono

---

### Task 1: Add `assistant` field to Session type

**Files:**
- Modify: `src/types/session.ts:3-8`

- [ ] **Step 1: Write the failing test**

No separate test file needed — the type change will be validated by the compiler and tested through integration in Task 5.

- [ ] **Step 2: Add `assistant` field to Session interface**

```typescript
// src/types/session.ts
import type { LLMMessage } from "./llm.ts";

export interface Session {
  id: string;
  assistant?: string;
  messages: LLMMessage[];
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/types/session.ts
git commit -m "feat(SP-31): add optional assistant field to Session type"
```

---

### Task 2: Add prompt cache and per-request assistant resolution helper

**Files:**
- Create: `src/services/assistant-resolver.ts`
- Create: `src/services/assistant-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/assistant-resolver.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { resolveAssistant, clearPromptCache } from "./assistant-resolver.ts";

beforeEach(() => {
  clearPromptCache();
});

describe("resolveAssistant", () => {
  it("resolves the default assistant with prompt, model, and toolFilter", async () => {
    const result = await resolveAssistant("default");
    expect(result.prompt).toBeDefined();
    expect(typeof result.prompt).toBe("string");
    expect(result.prompt.length).toBeGreaterThan(0);
    expect(typeof result.model).toBe("string");
    // toolFilter may be undefined for default
  });

  it("throws for unknown assistant name", async () => {
    await expect(resolveAssistant("nonexistent")).rejects.toThrow(/Unknown assistant/);
  });

  it("caches prompts — second call returns same content", async () => {
    const first = await resolveAssistant("default");
    const second = await resolveAssistant("default");
    expect(first.prompt).toBe(second.prompt);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/assistant-resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the assistant resolver**

```typescript
// src/services/assistant-resolver.ts
import { assistants } from "./assistants.ts";
import { promptService } from "./prompt.ts";
import type { ToolFilter } from "../types/assistant.ts";

interface ResolvedAssistant {
  prompt: string;
  model: string;
  toolFilter?: ToolFilter;
}

const promptCache = new Map<string, ResolvedAssistant>();

export async function resolveAssistant(name: string): Promise<ResolvedAssistant> {
  const cached = promptCache.get(name);
  if (cached) return cached;

  const assistant = await assistants.get(name);
  const actPrompt = await promptService.load("act", {
    objective: assistant.objective,
    tone: assistant.tone,
  });

  const resolved: ResolvedAssistant = {
    prompt: actPrompt.content,
    model: assistant.model ?? actPrompt.model!,
    toolFilter: assistant.tools,
  };

  promptCache.set(name, resolved);
  return resolved;
}

export function clearPromptCache(): void {
  promptCache.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/assistant-resolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/assistant-resolver.ts src/services/assistant-resolver.test.ts
git commit -m "feat(SP-31): add assistant-resolver with prompt caching"
```

---

### Task 3: Refactor `/chat` handler to resolve assistant per-request

**Files:**
- Modify: `src/server.ts:1-99`

- [ ] **Step 1: Rewrite server.ts**

Replace the module-level assistant resolution (lines 10-17) and update the `/chat` handler to resolve per-request:

```typescript
// src/server.ts
import { Hono } from "hono";
import { runAgent } from "./agent.ts";
import { sessionService } from "./services/session.ts";
import { resolveAssistant } from "./services/assistant-resolver.ts";
import { log } from "./services/logger.ts";
import { config } from "./config/index.ts";
import type { LLMMessage } from "./types/llm.ts";

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

  // Resolve assistant name — from body, existing session, or default
  const requestedAssistant = typeof body.assistant === "string" && body.assistant !== ""
    ? body.assistant
    : undefined;

  const { msg } = body as { msg: string };

  try {
    const answer = await sessionService.enqueue(sessionId, async () => {
      const session = sessionService.getOrCreate(sessionId);

      // Determine assistant: session-pinned > request > "default"
      let assistantName: string;
      if (session.assistant) {
        assistantName = session.assistant;
        if (requestedAssistant && requestedAssistant !== session.assistant) {
          log.warn(
            `/chat [${sessionId}]: ignoring assistant="${requestedAssistant}", session pinned to "${session.assistant}"`,
          );
        }
      } else {
        assistantName = requestedAssistant ?? "default";
      }

      // Resolve assistant — assistants.get() throws with available names if unknown
      let resolved;
      try {
        resolved = await resolveAssistant(assistantName);
      } catch (err) {
        if (err instanceof Error && err.message.includes("Unknown assistant")) {
          throw Object.assign(new Error(err.message), { statusCode: 400 });
        }
        throw err;
      }

      // Pin assistant to session on first interaction
      if (!session.assistant) {
        session.assistant = assistantName;
      }

      // First interaction — prepend system prompt
      if (session.messages.length === 0) {
        sessionService.appendMessage(sessionId, {
          role: "system",
          content: resolved.prompt,
        });
      }

      sessionService.appendMessage(sessionId, { role: "user", content: msg });

      // Pass a copy so runAgent's pushes don't double-add to session
      const messages: LLMMessage[] = [...session.messages];
      const result = await runAgent(messages, undefined, {
        model: resolved.model,
        sessionId,
        toolFilter: resolved.toolFilter,
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
    const statusCode = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    if (statusCode === 400) {
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
```

- [ ] **Step 2: Run existing tests to verify nothing is broken**

Run: `bun test src/server.test.ts`
Expected: PASS (existing tests still work — default assistant is used when no `body.assistant`)

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(SP-31): resolve assistant per-request in /chat handler"
```

---

### Task 4: Update and expand server tests

**Files:**
- Modify: `src/server.test.ts`

- [ ] **Step 1: Add test for explicit assistant selection**

```typescript
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
```

- [ ] **Step 2: Add test for unknown assistant returning 400**

```typescript
it("returns 400 for unknown assistant with available names", async () => {
  const res = await request("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "s-bad", msg: "hi", assistant: "nonexistent" }),
  });
  expect(res.status).toBe(400);
  const json = await res.json();
  expect(json.error).toContain("Unknown assistant");
  expect(json.error).toContain("nonexistent");
  expect(json.error).toContain("default");
});
```

- [ ] **Step 3: Add test for session assistant persistence (pinning)**

```typescript
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
```

- [ ] **Step 4: Add test for default fallback when no assistant specified**

```typescript
it("falls back to default assistant when not specified", async () => {
  await request("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "s-default", msg: "hi" }),
  });

  const session = sessionService.getOrCreate("s-default");
  expect(session.assistant).toBe("default");
});
```

- [ ] **Step 5: Add test for session reuse without assistant field**

```typescript
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
  // system + user + assistant + user + assistant = 5
  expect(session.messages.length).toBe(5);
});
```

- [ ] **Step 6: Add test for non-string assistant (falls back to default)**

```typescript
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
```

- [ ] **Step 7: Add test for empty string assistant (falls back to default)**

```typescript
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
```

- [ ] **Step 8: Run all tests**

Run: `bun test src/server.test.ts`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add src/server.test.ts
git commit -m "test(SP-31): add tests for per-request assistant selection"
```

---

### Task 5: Remove `config.assistant` from server usage

**Files:**
- Modify: `src/config/index.ts:77` (no change needed — keep for CLI compat)
- Verify: `src/server.ts` no longer imports or uses `config.assistant`

- [ ] **Step 1: Verify server.ts no longer references config.assistant**

Run: `grep -n "config.assistant" src/server.ts`
Expected: No output (already removed in Task 4)

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All PASS

- [ ] **Step 3: Commit (if any cleanup was needed)**

Only commit if changes were made. Otherwise skip.

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All PASS

- [ ] **Step 2: Manual smoke test**

Run: `bun run src/server.ts &`
Then test with curl:
```bash
# Default assistant
curl -X POST http://localhost:3000/chat -H 'Content-Type: application/json' -d '{"sessionId":"t1","msg":"hi"}'

# Explicit assistant
curl -X POST http://localhost:3000/chat -H 'Content-Type: application/json' -d '{"sessionId":"t2","msg":"hi","assistant":"proxy"}'

# Invalid assistant
curl -X POST http://localhost:3000/chat -H 'Content-Type: application/json' -d '{"sessionId":"t3","msg":"hi","assistant":"nonexistent"}'
```
