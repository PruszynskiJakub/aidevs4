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

- **Drizzle ORM + `bun:sqlite`** — typed schema definitions, generated SQL
  migrations. No raw SQL outside `src/infra/db/`.
  - `drizzle-orm` — runtime query builder + migrator
  - `drizzle-kit` — dev dependency for `generate` / `migrate` CLI commands
  - Driver: `drizzle-orm/bun-sqlite` (uses Bun's built-in `bun:sqlite`, no
    extra native dependency)
  - No additional abstraction layer (no `DbProvider` interface) — Drizzle
    itself is the typed abstraction. If a Postgres migration is ever needed,
    swap the Drizzle driver and regenerate migrations.
- **Environment-aware database path** — configured via `DATABASE_URL` env var,
  wired through `src/config/env.ts` → `config.database.url`. Single source of
  truth for the default (`./data/dev.db`). Prod sets
  `DATABASE_URL=/data/aidevs/prod.db` via Docker env. The DB file is never
  committed — `data/` is added to `.gitignore`.
- **Migrations via Drizzle Kit** — schema changes follow a strict workflow:
  1. Edit schema in `src/infra/db/schema.ts`
  2. Run `bun run db:generate` — produces a numbered SQL migration in
     `src/infra/db/migrations/`
  3. Review and commit the generated migration file
  4. On container startup, a dedicated `bun run db:migrate` step applies
     pending migrations before services start
  - `drizzle-kit push` is **forbidden in prod** — all prod changes go through
    generated migrations
  - Migration files are committed to git — they are source code, not artifacts
- **Everything under `src/infra/db/`** — schema, connection, migrations, and
  query functions all live in one directory. Consumers import from
  `src/infra/db/index.ts`. No cross-directory coupling.
- **WAL mode** for concurrent read performance (set via pragma on connection
  init, inside `src/infra/db/`).
- **Transaction boundaries** at turn level — each turn's items (assistant
  message + tool calls + tool results) are inserted in a single Drizzle
  transaction. Crash mid-turn = no partial state.
- **Backward compatible** — existing file-based artifacts (logs, memory,
  outputs) are unaffected. The in-memory session store is replaced, not layered.
- **Migrations run as a dedicated startup step** — the Docker entrypoint runs
  `bun run db:migrate` before starting `server` and `slack`. This avoids
  multi-process race conditions (server and slack are separate processes with
  separate module caches).

## Acceptance criteria

- [ ] DB file is created on first run at the path specified by `DATABASE_URL`
- [ ] Drizzle migrations run automatically on app startup via `migrate()`
- [ ] Sessions survive process restart — `--session ID` resumes with full
      message history
- [ ] Agent hierarchy is persisted — parent/child relationships queryable
      after execution
- [ ] All conversation items (user messages, assistant messages, tool calls,
      tool results) are stored with correct sequence ordering
- [ ] `delegate` tool spawns are tracked with `source_call_id` linking the
      spawning tool call to the child agent
- [ ] In-memory `sessionService` replaced — reads/writes go through DB
- [ ] In-memory `resultStore` replaced — reads go through SQLite directly
      (no in-memory cache; `bun:sqlite` sync reads are fast enough)
- [ ] Existing tests pass; new tests cover DB service CRUD operations
- [ ] Agent runs produce identical behavior — DB is transparent to the
      agent loop

## Implementation plan

### 1. Schema, connection & migrations

#### Dependencies

```bash
bun add drizzle-orm
bun add -d drizzle-kit
```

#### File structure

Everything lives under `src/infra/db/`:

```
src/
  infra/
    db/
      schema.ts            # Drizzle table definitions (source of truth)
      connection.ts        # bun:sqlite Database + Drizzle instance
      migrate.ts           # Standalone migration runner (called from CLI)
      index.ts             # Re-exports db instance + query functions
      migrations/          # Generated SQL files (committed to git)
        0001_initial.sql
        meta/              # Drizzle Kit metadata (committed)
drizzle.config.ts          # Drizzle Kit config (project root)
```

#### Environment configuration

Add `DATABASE_URL` to `src/config/env.ts` (single source of truth for the
default):

```typescript
databaseUrl: process.env.DATABASE_URL ?? "./data/dev.db",
```

Add to `src/config/index.ts`:

```typescript
database: {
  url: env.databaseUrl,
},
```

All DB code reads the path from `config.database.url` — never from
`process.env` directly. The only exception is `drizzle.config.ts`, which is
a standalone CLI tool config and must read `process.env`.

#### Drizzle schema (`src/infra/db/schema.ts`)

```typescript
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const timestamp = () =>
  text().notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

export const sessions = sqliteTable("sessions", {
  id:          text("id").primaryKey(),
  rootAgentId: text("root_agent_id"),
  title:       text("title"),
  createdAt:   timestamp(),
  updatedAt:   timestamp(),
});

export const agents = sqliteTable("agents", {
  id:            text("id").primaryKey(),
  sessionId:     text("session_id").notNull().references(() => sessions.id),
  parentId:      text("parent_id").references(() => agents.id),
  sourceCallId:  text("source_call_id"),
  template:      text("template").notNull(),
  task:          text("task").notNull(),
  status:        text("status", { enum: ["pending", "running", "completed", "failed"] })
                   .notNull().default("pending"),
  result:        text("result"),
  error:         text("error"),
  turnCount:     integer("turn_count").notNull().default(0),
  createdAt:     timestamp(),
  startedAt:     text("started_at"),
  completedAt:   text("completed_at"),
}, (table) => [
  index("idx_agents_session").on(table.sessionId),
  index("idx_agents_parent").on(table.parentId),
]);

export const items = sqliteTable("items", {
  id:        text("id").primaryKey(),
  agentId:   text("agent_id").notNull().references(() => agents.id),
  sequence:  integer("sequence").notNull(),
  type:      text("type", { enum: ["message", "function_call", "function_call_output"] })
               .notNull(),
  role:      text("role"),
  content:   text("content"),
  callId:    text("call_id"),
  name:      text("name"),
  arguments: text("arguments"),
  output:    text("output"),
  createdAt: timestamp(),
}, (table) => [
  uniqueIndex("idx_items_agent_seq").on(table.agentId, table.sequence),
  index("idx_items_call_id").on(table.callId),
]);
```

#### Connection (`src/infra/db/connection.ts`)

```typescript
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "../../config/index.ts";
import * as schema from "./schema.ts";

mkdirSync(dirname(config.database.url), { recursive: true });

const sqlite = new Database(config.database.url);
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { sqlite };  // exported for shutdown cleanup
```

PRAGMAs are raw SQL but contained within the connection bootstrap file inside
`src/infra/db/` — consistent with the "no raw SQL outside this directory" rule.

#### Migration runner (`src/infra/db/migrate.ts`)

```typescript
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "./connection.ts";

migrate(db, { migrationsFolder: "./src/infra/db/migrations" });
```

Called as a standalone script from Docker entrypoint or `package.json`:

```bash
bun run src/infra/db/migrate.ts
```

#### Drizzle Kit config (`drizzle.config.ts`)

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/infra/db/schema.ts",
  out: "./src/infra/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "./data/dev.db",
  },
});
```

Note: `drizzle.config.ts` reads `process.env` directly because it runs as a
standalone CLI tool, outside the app runtime. The default is duplicated here
by necessity.

#### Package scripts

Add to `package.json`:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "bun run src/infra/db/migrate.ts"
  }
}
```

#### Migration workflow

```bash
# After editing schema.ts:
bun run db:generate             # produces numbered SQL migration

# Review the generated SQL, then commit it:
git add src/infra/db/migrations/

# On next app start (or manually):
bun run db:migrate              # applies pending migrations
```

### 2. Query functions (`src/infra/db/index.ts`)

Export typed query functions from `src/infra/db/index.ts` — no `DbProvider`
interface. Drizzle's typed query builder is the abstraction layer.

```typescript
// Sessions
createSession(id: string): void
getSession(id: string): DbSession | null
touchSession(id: string): void
setRootAgent(sessionId: string, agentId: string): void

// Agents
createAgent(opts: CreateAgentOpts): void
getAgent(id: string): DbAgent | null
updateAgentStatus(id: string, status: AgentStatus, result?: string, error?: string): void
listAgentsBySession(sessionId: string): DbAgent[]

// Items
appendItem(agentId: string, item: NewItem): void
appendItems(agentId: string, items: NewItem[]): void  // wraps in transaction
listItemsByAgent(agentId: string): DbItem[]
listItemsBySession(sessionId: string): DbItem[]       // joins through agents
nextSequence(agentId: string): number
```

`appendItems` wraps inserts in a Drizzle `db.transaction()` — used at turn
boundaries to atomically persist the assistant message + tool calls + tool
results. Single `appendItem` is available for the initial user message.

**Note on `bun:sqlite` sync nature**: Drizzle over `bun:sqlite` is
synchronous. For single-session CLI usage this is negligible (~50-200μs per
statement). For `server.ts` with concurrent sessions, writes serialize
briefly. Acceptable for current scale.

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
- No in-memory cache — read directly from SQLite. `bun:sqlite` synchronous
  reads are ~50-200μs, negligible vs LLM latency. Avoids cache invalidation
  complexity.

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

### 6. Bootstrap & deployment

In `src/infra/bootstrap.ts`:
- `initServices()`: import `src/infra/db/connection.ts` to initialize the
  Drizzle instance. Migrations are NOT run here — they run as a separate
  step before the app starts.
- `shutdownServices()`: call `sqlite.close()` on the underlying `bun:sqlite`
  `Database` instance (exported from `connection.ts`).

Docker entrypoint (Dockerfile `CMD`):
```bash
bun run db:migrate && bun run server & bun run slack & wait
```

Migrations run once before either service starts, avoiding multi-process
race conditions.

Add `data/` to `.gitignore` and `DATABASE_URL` to `.env.example`.

### 7. Update types

- Add `src/types/db.ts`:
  - Plain TypeScript interfaces: `DbSession`, `DbAgent`, `DbItem` — no
    Drizzle imports, no `$inferSelect`. Defined manually to keep the types
    file independent of the ORM.
  - Input types: `CreateAgentOpts`, `NewItem`
  - `AgentStatus = 'pending' | 'running' | 'completed' | 'failed'`
- These are **separate from** existing runtime types (`Session`, `AgentState`,
  `LLMMessage`). The query functions in `src/infra/db/index.ts` translate
  between them:
  - `DbSession` ↔ `Session` (mapping in sessionService)
  - `DbAgent` is new — no existing runtime equivalent persists this data
  - `DbItem[]` ↔ `LLMMessage[]` (mapping in sessionService)
- Consumers import query functions from `src/infra/db/index.ts`.

## Testing scenarios

| Criterion | Test |
|-----------|------|
| DB created on first run | Unit: point `DATABASE_URL` at a temp path, import `db.ts`, assert tables exist via `sqlite_master` query |
| Migrations run | Unit: create empty DB, run `migrate()`, assert all tables and indexes exist |
| Session resume | Integration: create session, append messages, re-import `connection.ts` (fresh process), load session, assert messages intact |
| Agent hierarchy | Unit: create session + parent agent + child agent with `parent_id`, query `db.agents.listBySession()`, assert tree structure |
| Item sequence ordering | Unit: append 5 items, query back, assert `sequence` is 0-4 in order |
| Message ↔ item round-trip | Unit: convert `LLMMessage[]` → items → `LLMMessage[]`, assert deep equality. Include multi-part content (ContentPart[] with text + image), null assistant content, and multiple tool calls per assistant message. |
| Turn atomicity | Unit: start `appendBatch`, kill mid-write (or simulate), assert no partial items exist |
| `source_call_id` tracking | Integration: run delegate tool, assert child agent row has `source_call_id` matching the function_call item |
| Existing tests pass | Run `bun test` — no regressions |
| Agent behavior unchanged | Manual: run `bun run agent "hello"`, verify identical log output and response quality |