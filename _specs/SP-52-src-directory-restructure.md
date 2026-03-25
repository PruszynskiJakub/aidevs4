# SP-52 Flatten src/ directory structure

## Main objective

Replace the nested `services/` hierarchy with three flat, self-explanatory
top-level folders (`agent/`, `llm/`, `infra/`) so every file has an obvious
home and you can navigate the codebase without memorizing a taxonomy.

## Context

The current `src/` layout groups code under `services/common/`,
`services/ai/`, `services/agent/`, `services/memory/`, plus a separate
`providers/` directory. Problems:

- **`services/common/`** is a dumping ground — file I/O, logging, moderation,
  and document formatting share no concept besides "not fitting elsewhere."
- **`services/ai/`** mixes LLM routing with prompt loading (unrelated concerns
  that happen to both touch "AI").
- **`providers/`** is separated from `services/ai/` even though they form one
  concept (call an LLM).
- **Six barrel `index.ts` files** create re-export chains that obscure where
  things actually live.
- **`utils/session-context.ts`** is agent infrastructure misfiled as a utility.

The result: you can't answer "where does X live?" without checking multiple
directories and barrel files.

### Current structure (files being moved)

```
src/
├── agent.ts                              → agent/loop.ts
├── providers/
│   ├── openai.ts                         → llm/openai.ts
│   └── gemini.ts                         → llm/gemini.ts
├── services/
│   ├── index.ts                          DELETE
│   ├── common/
│   │   ├── index.ts                      DELETE
│   │   ├── file.ts                       → infra/file.ts
│   │   ├── document-store.ts             → infra/document.ts
│   │   ├── guard.ts                      → infra/guard.ts
│   │   └── logging/
│   │       ├── index.ts                  DELETE
│   │       ├── logger.ts                 → infra/log/logger.ts
│   │       ├── console-logger.ts         → infra/log/console.ts
│   │       ├── markdown-logger.ts        → infra/log/markdown.ts
│   │       └── composite-logger.ts       → infra/log/composite.ts
│   ├── ai/
│   │   ├── index.ts                      DELETE
│   │   ├── llm.ts                        → llm/llm.ts
│   │   ├── prompt.ts                     → llm/prompt.ts
│   │   └── provider-registry.ts          → llm/router.ts
│   ├── agent/
│   │   ├── index.ts                      DELETE
│   │   ├── orchestrator.ts               → agent/orchestrator.ts
│   │   ├── session.ts                    → agent/session.ts
│   │   └── agents/
│   │       ├── index.ts                  DELETE
│   │       └── agents.ts                 → agent/agents.ts
│   └── memory/
│       ├── processor.ts                  → agent/memory/processor.ts
│       ├── observer.ts                   → agent/memory/observer.ts
│       ├── reflector.ts                  → agent/memory/reflector.ts
│       └── persistence.ts               → agent/memory/persistence.ts
├── utils/
│   └── session-context.ts                → agent/context.ts
```

### Target structure

```
src/
├── agent/                    # The brain — loop, orchestration, session, memory
│   ├── loop.ts               # Plan/Act state machine (was agent.ts)
│   ├── orchestrator.ts       # executeTurn entry point
│   ├── session.ts            # Session store + output paths
│   ├── agents.ts             # Agent config loader (.agent.md)
│   ├── context.ts            # AsyncLocalStorage (was session-context.ts)
│   └── memory/
│       ├── processor.ts      # Observation/reflection orchestration
│       ├── observer.ts       # Message summarization
│       ├── reflector.ts      # Multi-level reflection
│       └── persistence.ts    # Disk save/load
│
├── llm/                      # Everything LLM: routing, providers, prompts
│   ├── llm.ts                # Provider registry singleton + factory
│   ├── router.ts             # Model→provider routing logic
│   ├── openai.ts             # OpenAI adapter (was providers/)
│   ├── gemini.ts             # Gemini adapter (was providers/)
│   └── prompt.ts             # Prompt loader (.md + YAML frontmatter)
│
├── infra/                    # I/O, side effects, external world
│   ├── file.ts               # Sandboxed file service
│   ├── document.ts           # Document store + XML formatting
│   ├── guard.ts              # Input moderation (OpenAI Moderation API)
│   └── log/
│       ├── logger.ts         # `log` singleton (console)
│       ├── console.ts        # ConsoleLogger class
│       ├── markdown.ts       # MarkdownLogger class
│       └── composite.ts      # createCompositeLogger factory
│
├── tools/                    # Unchanged
├── config/                   # Unchanged
├── types/                    # Unchanged
├── schemas/                  # Unchanged
├── prompts/                  # Unchanged
├── utils/                    # Pure helpers only (parse, tokens, xml, id, timing)
│
├── cli.ts
└── server.ts
```

## Out of scope

- Changing singleton patterns — all module-level singletons stay as-is
- Refactoring logic within any file (only moves + import path updates)
- Changing the tool system (`tools/`, `schemas/`)
- Changing `config/`, `types/`, `prompts/`, or `utils/` (except removing
  `session-context.ts` from utils)
- Adding interfaces, ports, or dependency injection
- Renaming exports or function signatures

## Constraints

- **Zero behavioral change** — every import must resolve to the same module it
  did before; only the path changes.
- **Tests must pass** after each phase — no "big bang" migration.
- **No barrel files** in the new structure — every import points directly to the
  source file. No `index.ts` re-exports.
- **Existing test files** move alongside their source files and have their
  imports updated too.

## Acceptance criteria

- [ ] `src/services/` directory no longer exists
- [ ] `src/providers/` directory no longer exists
- [ ] `src/utils/session-context.ts` no longer exists
- [ ] No `index.ts` barrel files remain in `agent/`, `llm/`, or `infra/`
- [ ] All imports across `src/` point to new paths (no broken imports)
- [ ] `bun test` passes with zero failures
- [ ] `bun run src/cli.ts "test"` starts the agent without errors
- [ ] No circular imports introduced (verify with `madge --circular`)

## Implementation plan

Execute in 5 phases. Each phase moves one folder, updates all imports, and
verifies tests pass before proceeding.

### Phase 1: Create `infra/` (move `services/common/`)

1. `mkdir -p src/infra/log`
2. Move files:
   - `services/common/file.ts` → `infra/file.ts`
   - `services/common/document-store.ts` → `infra/document.ts`
   - `services/common/guard.ts` → `infra/guard.ts`
   - `services/common/logging/logger.ts` → `infra/log/logger.ts`
   - `services/common/logging/console-logger.ts` → `infra/log/console.ts`
   - `services/common/logging/markdown-logger.ts` → `infra/log/markdown.ts`
   - `services/common/logging/composite-logger.ts` → `infra/log/composite.ts`
3. Update all imports across `src/` that reference old paths.
   Key consumers (from import map):
   - `file.ts`: 11 files (tools, services, tests)
   - `document-store.ts`: 11 files (tools, registry, agent.ts)
   - `guard.ts`: 1 file (orchestrator.ts)
   - `logging/*`: 3 files (agent.ts, server.ts, logger.ts internals)
4. Update internal imports within moved files (e.g., `markdown-logger.ts`
   imports from `file.ts` — both move, relative path changes).
5. Delete `services/common/logging/index.ts`, `services/common/index.ts`.
6. Run `bun test` — fix any breakage.

### Phase 2: Create `llm/` (move `services/ai/` + `providers/`)

1. `mkdir -p src/llm`
2. Move files:
   - `services/ai/llm.ts` → `llm/llm.ts`
   - `services/ai/prompt.ts` → `llm/prompt.ts`
   - `services/ai/provider-registry.ts` → `llm/router.ts`
   - `providers/openai.ts` → `llm/openai.ts`
   - `providers/gemini.ts` → `llm/gemini.ts`
3. Update imports. Key consumers:
   - `llm.ts`: 4 files (agent.ts, think.ts, prompt_engineer.ts,
     document_processor.ts)
   - `prompt.ts`: 3 files (agent.ts, think.ts, prompt_engineer.ts) +
     memory observer/reflector
   - `provider-registry.ts`: only `llm.ts` (internal)
   - `openai.ts`/`gemini.ts`: only `llm.ts`
4. Update `llm.ts` internal imports to point to `./openai` and `./gemini`
   instead of `../../providers/`.
5. Update `prompt.ts` internal import from `../common/file.ts` to
   `../infra/file.ts`.
6. Delete `services/ai/index.ts`, `providers/` directory.
7. Run `bun test`.

### Phase 3: Create `agent/` (move `services/agent/` + `services/memory/` + `agent.ts`)

1. `mkdir -p src/agent/memory`
2. Move files:
   - `agent.ts` → `agent/loop.ts`
   - `services/agent/orchestrator.ts` → `agent/orchestrator.ts`
   - `services/agent/session.ts` → `agent/session.ts`
   - `services/agent/agents/agents.ts` → `agent/agents.ts`
   - `utils/session-context.ts` → `agent/context.ts`
   - `services/memory/processor.ts` → `agent/memory/processor.ts`
   - `services/memory/observer.ts` → `agent/memory/observer.ts`
   - `services/memory/reflector.ts` → `agent/memory/reflector.ts`
   - `services/memory/persistence.ts` → `agent/memory/persistence.ts`
3. Update imports. Key consumers:
   - `session-context.ts` (`context.ts`): 13 files (all tools, file.ts,
     session.ts, agent.ts)
   - `agent.ts` (`loop.ts`): 1 file (orchestrator.ts)
   - `orchestrator.ts`: 2 files (cli.ts, server.ts)
   - `session.ts`: 3 files (server.ts, orchestrator.ts, web.ts)
   - `agents.ts`: 2 files (agent.ts, orchestrator.ts)
   - `memory/*`: only agent.ts and internal cross-refs
4. Update all internal imports within moved files.
5. Delete `services/agent/agents/index.ts`, `services/agent/index.ts`.
6. Run `bun test`.

### Phase 4: Cleanup

1. Delete `services/index.ts`.
2. `rmdir` empty `services/` tree (should be fully empty).
3. `rmdir` empty `providers/` directory.
4. Verify no file in `src/` imports from `services/` or `providers/`.
5. Run `bun test`.

### Phase 5: Verify end-to-end

1. `bun test` — all tests pass.
2. `bun run src/cli.ts "test"` — agent starts, no import errors.
3. Verify no circular imports: `bunx madge --circular --extensions ts src/`.
4. Update `CLAUDE.md` project structure section to reflect new layout.

## Testing scenarios

| Criterion | Verification |
|---|---|
| `services/` gone | `ls src/services` → "No such file or directory" |
| `providers/` gone | `ls src/providers` → "No such file or directory" |
| `session-context.ts` moved | `ls src/utils/session-context.ts` → not found |
| No barrel files | `find src/agent src/llm src/infra -name 'index.ts'` → empty |
| Imports resolve | `bun build src/cli.ts --target bun` succeeds with no errors |
| Tests pass | `bun test` → 0 failures |
| Agent runs | `bun run src/cli.ts "say hello"` → agent responds |
| No circular deps | `bunx madge --circular --extensions ts src/` → no cycles |
