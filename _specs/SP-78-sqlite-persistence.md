# SP-78 SQLite Persistence Layer

## Main objective

Introduce a SQLite database (`bun:sqlite`) with three tables — `sessions`,
`agents`, `items` — to durably store session state, agent execution hierarchy,
and conversation items (messages, tool calls, tool results), replacing the
in-memory `Map`-based session and result stores.

## Context

### What exists today

| Concern | Current storage | Limitation |
|---------|----------------|------------|
| Sessions | In-memory `Map` with 30-min TTL (`src/agent/session.ts`) | Lost on restart. `--session ID` can't truly resume. |
| Messages | `session.messages[]` array in memory | Lost on restart. No cross-session queries. |
| Agent instances | `AgentState` created per `executeTurn()`, lives on stack | No audit trail. Parent-child hierarchy is ephemeral. |
| Tool calls | In-memory `resultStore` (`src/infra/result-store.ts`) | Lost on restart. No historical queries. |
| Memory state | JSON file per session (`memory-state.json`) | Stays as-is (intentionally file-based). |
| Events/telemetry | JSONL files + Langfuse | Stays as-is. |

### Course reference

The AI Devs 4 S01E01 "Multi-Agent System Schema" defines a 3-table model:
**sessions** (user-facing container), **agents** (runtime instances with
parent-child hierarchy), **items** (polymorphic conversation entries per agent).
This spec adapts that model to the existing codebase.

### Why now

The `delegate` tool (`src/tools/delegate.ts`) already creates child agents with
`parentAgentId`, `rootAgentId`, and `depth` — but the hierarchy vanishes after
the process ends. Persisting it enables: session resume after restart,
cross-session agent tracing, and historical tool call analysis.

## Out of scope

- **Memory persistence** — stays in filesystem (`memory-state.json`)
- **Events/telemetry** — stays in JSONL files + Langfuse
- **Knowledge accumulation / FTS5** — separate future spec
- **Session status enum** — not needed yet
- **Reasoning item type** — not needed yet
- **Large tool result storage** — stays as files; items store the
  conversation-facing string only

## Constraints

- **`bun:sqlite` only** — zero external dependencies. No ORM.
- **Schema versioning** via `PRAGMA user_version` — each migration bumps the
  version. Migrations run forward-only on startup.
- **Single DB file** at `workspace/db/agent.db` (gitignored).
- **No raw SQL in tools or agent code** — all access through a `db` service
  in `src/infra/db.ts`. Tools and orchestrator call typed methods.
- **WAL mode** for concurrent read performance.
- **Transaction boundaries** at turn level — each turn's items (assistant
  message + tool calls + tool results) are inserted in a single transaction.
  Crash mid-turn = no partial state.
- **Backward compatible** — existing file-based artifacts (logs, memory,
  outputs) are unaffected. The in-memory session store is replaced, not layered.

## Acceptance criteria

- [ ] `workspace/db/agent.db` is created on first run with correct schema
- [ ] Schema migrations run automatically via `PRAGMA user_version`
- [ ] Sessions survive process restart — `--session ID` resumes with full
      message history
- [ ] Agent hierarchy is persisted — parent/child relationships queryable
      after execution
- [ ] All conversation items (user messages, assistant messages, tool calls,
      tool results) are stored with correct sequence ordering
- [ ] `delegate` tool spawns are tracked with `source_call_id` linking the
      spawning tool call to the child agent
- [ ] In-memory `sessionService` replaced — reads/writes go through DB
- [ ] In-memory `resultStore` replaced for persistence (may keep in-memory
      cache for hot-path reads during execution)
- [ ] Existing tests pass; new tests cover DB service CRUD operations
- [ ] Agent runs produce identical behavior — DB is transparent to the
      agent loop

## Implementation plan

### 1. Schema & migrations (`src/infra/db.ts`)

Create the DB service with `bun:sqlite`. Three tables:

```sql
-- sessions: user-facing conversation container
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  root_agent_id TEXT,
  title         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- agents: runtime instances with parent-child hierarchy
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  parent_id       TEXT REFERENCES agents(id),
  source_call_id  TEXT,
  template        TEXT NOT NULL,       -- agent name (e.g. "default", "negotiations")
  task            TEXT NOT NULL,        -- the prompt that started this agent
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','running','completed','failed')),
  result          TEXT,
  error           TEXT,
  turn_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at      TEXT,
  completed_at    TEXT
);

-- items: polymorphic conversation entries per agent
CREATE TABLE items (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  sequence   INTEGER NOT NULL,
  type       TEXT NOT NULL
             CHECK(type IN ('message','function_call','function_call_output')),
  -- message fields
  role       TEXT,
  content    TEXT,                    -- JSON for multi-part, plain string for text
  -- function_call fields
  call_id    TEXT,
  name       TEXT,
  arguments  TEXT,
  -- function_call_output fields
  output     TEXT,
  -- meta
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_agents_session ON agents(session_id);
CREATE INDEX idx_agents_parent ON agents(parent_id);
CREATE UNIQUE INDEX idx_items_agent_seq ON items(agent_id, sequence);
CREATE INDEX idx_items_call_id ON items(call_id);
```

Migration approach:
- `PRAGMA user_version` starts at 0 (no DB)
- Version 1: create the three tables above
- On startup: open DB, check `user_version`, run pending migrations, set new
  version
- Expose: `db.init()`, `db.close()`

### 2. DB service typed API (`src/infra/db.ts`)

Expose methods, not SQL, to the rest of the codebase:

```typescript
// Sessions
db.sessions.create(id: string): void
db.sessions.get(id: string): DbSession | null
db.sessions.touch(id: string): void
db.sessions.setRootAgent(id: string, agentId: string): void

// Agents
db.agents.create(opts: CreateAgentOpts): void
db.agents.get(id: string): DbAgent | null
db.agents.updateStatus(id: string, status: AgentStatus, result?: string, error?: string): void
db.agents.listBySession(sessionId: string): DbAgent[]

// Items
db.items.append(agentId: string, item: NewItem): void
db.items.appendBatch(agentId: string, items: NewItem[]): void  // wraps in transaction
db.items.listByAgent(agentId: string): DbItem[]
db.items.listBySession(sessionId: string): DbItem[]            // joins through agents
db.items.nextSequence(agentId: string): number
```

All write methods use prepared statements. `appendBatch` wraps inserts in an
explicit transaction — used at turn boundaries to atomically persist the
assistant message + tool calls + tool results. Single `append` is available
for the initial user message.

**Note on `bun:sqlite` sync nature**: All DB calls are synchronous and block
the event loop. For single-session CLI usage this is negligible (~50-200μs per
statement). For `server.ts` with concurrent sessions, writes serialize briefly
at the JS level. This is acceptable for the current scale; if it becomes a
bottleneck, writes can be deferred to a microtask batch.

### 3. Replace `sessionService` (`src/agent/session.ts`)

Rewrite to delegate to `db`:
- `getOrCreate(id)` → `db.sessions.get(id) ?? db.sessions.create(id)`
- `appendMessage(id, agentId, message)` → convert `LLMMessage` to item(s),
  call `db.items.append()`. Caller must pass `agentId` to scope items correctly.
- `appendTurn(id, agentId, messages)` → convert batch of `LLMMessage[]` to
  items, call `db.items.appendBatch()` in a single transaction. Used at end of
  each loop iteration (assistant message + tool calls + tool results).
- `getMessages(id, agentId)` → `db.items.listByAgent(agentId)` → reconstruct
  `LLMMessage[]`. Each agent has its own conversation — child agents spawned
  via `delegate` get independent item streams.
- Remove in-memory `Map`, TTL expiry timer, and `_clear()` test helper
- Keep `enqueue()` for per-session serial execution (in-memory concern)
- Keep path helpers (`sessionDir`, `logDir`, `outputPath`) unchanged

Message ↔ item mapping:

| LLMMessage | Item type | Fields used |
|------------|-----------|-------------|
| `{ role: "user", content }` | `message` | role="user", content (string stored as-is; `ContentPart[]` stored as JSON) |
| `{ role: "assistant", content, toolCalls? }` | `message` + N × `function_call` | message: role="assistant", content (may be null); then one function_call per toolCall with call_id, name, arguments |
| `{ role: "tool", toolCallId, content }` | `function_call_output` | call_id=toolCallId, output=content |
| `{ role: "system", content }` | Not stored (injected at runtime from agent config) |

**Content encoding**: `content` column stores plain strings for simple text
messages. For `LLMUserMessage` with `ContentPart[]` (text, images, resource
refs), content is JSON-encoded. The reconstruction logic checks if content
parses as JSON array — if so, it's multi-part; otherwise it's a plain string.
`ImagePart` base64 data is stored inline (images in messages are already in
the LLM context window, so they're bounded by LLM limits, not unbounded blobs).

### 4. Replace `resultStore` (`src/infra/result-store.ts`)

Tool call lifecycle now persists through items:
- `resultStore.create(toolCallId, toolName, args)` → `function_call` item
  already written when assistant message is stored (step 3)
- `resultStore.complete(toolCallId, result, tokens)` → `function_call_output`
  item written when tool result message is stored
- For hot-path reads during execution (e.g. `resultStore.get()`), keep a
  thin in-memory cache that shadows the DB writes. Clear per-session.

### 5. Wire agent hierarchy in orchestrator

In `orchestrator.ts`:
- Add `sourceCallId?: string` to `ExecuteTurnOpts` interface
- After creating `agentId`, call `db.agents.create()` with session_id,
  parent_id, source_call_id, template (agent name), task (prompt)
- Call `db.sessions.setRootAgent(sessionId, agentId)` for root agents
  (when no parentAgentId)
- Set `status = 'running'`, `started_at = now`
- On completion: `db.agents.updateStatus(agentId, 'completed', answer)`
- On error: `db.agents.updateStatus(agentId, 'failed', undefined, error.message)`

In `delegate.ts`:
- Capture the triggering `toolCallId` from the dispatch context and pass it
  to `executeTurn()` as `sourceCallId`
- Orchestrator stores it as `source_call_id` on the child agent row

### 6. Bootstrap integration

In `src/infra/bootstrap.ts`:
- `initServices()`: call `db.init()` (open DB, run migrations)
- `shutdownServices()`: call `db.close()`

Add `workspace/db/` to `.gitignore`.

### 7. Update types

- Add `src/types/db.ts` with row-level types: `DbSession`, `DbAgent`, `DbItem`,
  `AgentStatus`, `CreateAgentOpts`, `NewItem`
- These are **separate from** existing runtime types (`Session`, `AgentState`,
  `LLMMessage`). The DB service translates between them:
  - `DbSession` ↔ `Session` (mapping in sessionService)
  - `DbAgent` is new — no existing runtime equivalent persists this data
  - `DbItem[]` ↔ `LLMMessage[]` (mapping in sessionService)
- `AgentStatus = 'pending' | 'running' | 'completed' | 'failed'` — matches
  the two terminal outcomes in the current orchestrator (success / throw)

## Testing scenarios

| Criterion | Test |
|-----------|------|
| DB created on first run | Unit: call `db.init()` with no existing file, assert tables exist via `sqlite_master` query |
| Migrations run | Unit: create DB at version 0, run `db.init()`, assert `user_version = 1` and tables exist |
| Session resume | Integration: create session, append messages, restart (new `db.init()`), load session, assert messages intact |
| Agent hierarchy | Unit: create session + parent agent + child agent with `parent_id`, query `db.agents.listBySession()`, assert tree structure |
| Item sequence ordering | Unit: append 5 items, query back, assert `sequence` is 0-4 in order |
| Message ↔ item round-trip | Unit: convert `LLMMessage[]` → items → `LLMMessage[]`, assert deep equality. Include multi-part content (ContentPart[] with text + image), null assistant content, and multiple tool calls per assistant message. |
| Turn atomicity | Unit: start `appendBatch`, kill mid-write (or simulate), assert no partial items exist |
| `source_call_id` tracking | Integration: run delegate tool, assert child agent row has `source_call_id` matching the function_call item |
| Existing tests pass | Run `bun test` — no regressions |
| Agent behavior unchanged | Manual: run `bun run agent "hello"`, verify identical log output and response quality |