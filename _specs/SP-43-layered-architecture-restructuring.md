# SP-43 Layered Architecture Restructuring

## Main objective

Restructure `src/services/` and `src/providers/` into explicit architectural layers (infrastructure, domain, adapters, application) with enforced dependency direction.

## Context

The current structure under `src/services/` conflates infrastructure services (file I/O, logging) with domain services (session, assistant) and application coordination (orchestrator, agent loop). This creates problematic dependency inversions — notably `file.ts` (infrastructure) imports `getSessionId()` from `session-context.ts` (domain), meaning infrastructure depends on domain.

Current layout:
```
src/services/
├── common/      — file, logging, document-store
├── ai/          — llm, provider-registry, prompt
└── agent/       — session, session-context, orchestrator, assistant/
src/providers/   — openai, gemini (external SDK wrappers)
```

Target layout:
```
src/infrastructure/        — file, logging, document-store (zero domain knowledge)
src/domain/
├── session/               — session, session-context (context propagation)
├── assistant/             — assistants, assistant-resolver
└── ai/                    — prompt, provider-registry (domain contracts)
src/adapters/ai/           — openai, gemini, llm (external system wiring)
src/application/           — agent loop, orchestrator (use-case coordination)
```

Dependency rule: `application → domain → infrastructure`. Adapters implement domain interfaces and are injected by the application layer. No layer may import from a layer above it.

### Current cross-layer dependency map

| Module | Imported by (count) | Layer |
|--------|---------------------|-------|
| `session-context.ts` | 12 tool files + file.ts + session.ts + agent.ts (15) | domain |
| `document-store.ts` | 10 tool files + registry.ts (11) | infrastructure |
| `file.ts` | 10 files (tools, loggers, session, assistants, prompt) | infrastructure |
| `llm.ts` | 4 files (agent.ts + 3 tools) | adapters |
| `prompt.ts` | 4 files (agent.ts + 2 tools + assistant-resolver) | domain |
| `session.ts` | 4 files (server, orchestrator, document_processor tool) | domain |

### Key dependency violations to fix

1. **`file.ts` → `session-context.ts`**: `narrowOutputPaths()` calls `getSessionId()` to scope output dirs to active session. Fix: inject sessionId via setter/callback instead of direct import.

2. **`prompt.ts` → `file.ts`**: Domain service reads prompt files from disk via infrastructure. This is acceptable — domain *uses* infrastructure (correct direction). No fix needed.

3. **`markdown-logger.ts` → `file.ts`**: Infrastructure-internal dependency. Stays together. No fix needed.

### Tool import matrix (what changes per phase)

Every tool file that imports from `services/` must be updated. Most tools are touched in Phase 1 **and** Phase 2; three are touched again in Phase 3. No barrel re-exports — consumers import directly from the target layer.

| Tool file | Phase 1 (infrastructure) | Phase 2 (domain) | Phase 3 (adapters) |
|---|---|---|---|
| `registry.ts` | createErrorDocument, formatDocumentsXml | — | — |
| `registry.test.ts` | createDocument | — | — |
| `web.ts` | files, createDocument | getSessionId, sessionService | — |
| `web.test.ts` | createBunFileService, _setFilesForTest | — | — |
| `bash.ts` | createDocument | getSessionId | — |
| `agents_hub.ts` | files, createDocument | getSessionId | — |
| `agents_hub.test.ts` | createBunFileService, _setFilesForTest | — | — |
| `document_processor.ts` | files, createDocument | getSessionId, sessionService | llm |
| `geo_distance.ts` | files, createDocument | getSessionId | — |
| `geo_distance.test.ts` | createBunFileService, _setFilesForTest | — | — |
| `shipping.ts` | createDocument | getSessionId | — |
| `prompt_engineer.ts` | createDocument | getSessionId, promptService | llm |
| `think.ts` | createDocument | getSessionId, promptService | llm |

**Totals**: Phase 1 touches 13 tool files, Phase 2 touches 10 tool files, Phase 3 touches 3 tool files.

### Non-tool consumers

| File | Phase 1 (infrastructure) | Phase 2 (domain) | Phase 3 (adapters) | Phase 4 (application) |
|---|---|---|---|---|
| `agent.ts` | MarkdownLogger, ConsoleLogger, createCompositeLogger | runWithContext, requireState, requireLogger, assistantResolverService, promptService | llm | — (moves itself) |
| `orchestrator.ts` | log | sessionService, assistantResolverService | — | — (moves itself) |
| `server.ts` | log | sessionService | — | executeTurn |
| `server.test.ts` | — | sessionService | — | — |
| `cli.ts` | — | — | — | executeTurn |
| `session.ts` | files | — (moves itself) | — | — |
| `assistants.ts` | files | — (moves itself) | — | — |
| `prompt.ts` | files | — (moves itself) | — | — |
| `llm.ts` | — | ProviderRegistry | — (moves itself) | — |
| `assistant-resolver.ts` | — | promptService, assistantsService (internal) | — | — |

## Out of scope

- Changes to tool logic (`src/tools/`) beyond import path updates
- Changes to schemas (`src/schemas/`)
- Changes to config (`src/config/`)
- Changes to utils (`src/utils/`)
- New functionality — this is a pure restructuring
- DRY fixes (covered by SP-42)

## Constraints

- **Phased migration**: one layer per PR, in order: infrastructure → domain → adapters → application
- **No barrel re-exports as shims**: consumers always import from the specific layer, never from a cross-layer barrel
- **All tests must pass after each phase** — each PR is independently shippable
- **No runtime behavior changes** — pure file moves and import rewrites
- **Bun bundler resolution** must continue to work (relative imports, no path aliases)
- **Tool import churn is unavoidable**: 13 tool files change in Phase 1, 10 in Phase 2, 3 in Phase 3 — accept this cost, coordinate to avoid merge conflicts with parallel tool work

## Acceptance criteria

- [ ] `src/infrastructure/` contains: `file.ts`, `logging/` (logger, console-logger, markdown-logger, composite-logger), `document-store.ts`, and barrel `index.ts`
- [ ] `src/domain/session/` contains: `session.ts`, `session-context.ts`
- [ ] `src/domain/assistant/` contains: `assistants.ts`, `assistant-resolver.ts`
- [ ] `src/domain/ai/` contains: `prompt.ts`, `provider-registry.ts`
- [ ] `src/adapters/ai/` contains: `openai.ts`, `gemini.ts`, `llm.ts`
- [ ] `src/application/` contains: `agent.ts`, `orchestrator.ts`
- [ ] `file.ts` no longer imports from session-context (dependency inversion fixed — session ID injected from above)
- [ ] No remaining `src/services/` or `src/providers/` directories
- [ ] Dependency rule enforced: grep confirms no infrastructure→domain, no infrastructure→application, no domain→application imports
- [ ] All existing tests pass (`bun test`)
- [ ] Agent runs end-to-end successfully (`bun run agent "test"`)

## Implementation plan

### Phase 1 — Infrastructure layer

**Goal**: Extract zero-domain-knowledge modules into `src/infrastructure/`.

**Files to move**:
- `services/common/file.ts` → `infrastructure/file.ts`
- `services/common/document-store.ts` → `infrastructure/document-store.ts`
- `services/common/document-store.test.ts` → `infrastructure/document-store.test.ts`
- `services/common/logging/*` → `infrastructure/logging/*`
- Create `infrastructure/index.ts` barrel

**Dependency fix — file.ts → session-context.ts**:

Current code in `file.ts`:
```typescript
import { getSessionId } from "../agent/session-context.ts";

function narrowOutputPaths(allowedDirs: string[]): string[] {
  const sessionId = getSessionId();  // ← domain dependency
  if (!sessionId) return allowedDirs;
  // ... scopes outputDir to session-specific subdir
}
```

Fix: Replace direct import with an injectable resolver:
```typescript
// infrastructure/file.ts
let sessionIdResolver: (() => string | undefined) = () => undefined;

export function setSessionIdResolver(resolver: () => string | undefined): void {
  sessionIdResolver = resolver;
}

function narrowOutputPaths(allowedDirs: string[]): string[] {
  const sessionId = sessionIdResolver();  // ← no domain import
  // ...
}
```

The application layer wires it during bootstrap:
```typescript
// Called once at startup (in orchestrator or agent init)
import { setSessionIdResolver } from "../infrastructure/file.ts";
import { getSessionId } from "../domain/session/session-context.ts";
setSessionIdResolver(getSessionId);
```

**Import updates required** (21 files total):
- **13 tool files** — see tool import matrix above (files, createDocument, createErrorDocument, formatDocumentsXml, createBunFileService, _setFilesForTest)
- **3 service files still in services/**: `prompt.ts` (files), `session.ts` (files), `assistants.ts` (files) — update to `../../infrastructure/file.ts`
- **2 application-level files**: `agent.ts` (MarkdownLogger, ConsoleLogger, createCompositeLogger), `orchestrator.ts` (log)
- **2 entry points**: `server.ts` (log)
- **1 internal**: `markdown-logger.ts` (relative path to file.ts changes)

**After this phase**: `services/common/` is deleted. `services/ai/` and `services/agent/` remain temporarily. Delete `services/index.ts` — no replacement barrel (consumers import from specific layers).

---

### Phase 2 — Domain layer

**Goal**: Extract domain concepts into `src/domain/`.

**Files to move**:
- `services/agent/session.ts` → `domain/session/session.ts`
- `services/agent/session-context.ts` → `domain/session/session-context.ts`
- `services/agent/session.test.ts` → `domain/session/session.test.ts`
- `services/agent/assistant/assistants.ts` → `domain/assistant/assistants.ts`
- `services/agent/assistant/assistant-resolver.ts` → `domain/assistant/assistant-resolver.ts`
- `services/ai/prompt.ts` → `domain/ai/prompt.ts`
- `services/ai/provider-registry.ts` → `domain/ai/provider-registry.ts`
- Create barrel files: `domain/index.ts`, `domain/session/index.ts`, `domain/assistant/index.ts`, `domain/ai/index.ts`

**Rationale for ai/ placement**:
- `prompt.ts` — defines how prompts are loaded/rendered, a domain contract. Uses `files` service (infra) for I/O — correct dependency direction.
- `provider-registry.ts` — pure class operating on `LLMProvider` type. Defines the domain abstraction for LLM access. Zero external dependencies.

**Import updates required** (17 files total):
- **10 tool files** — see tool import matrix above (getSessionId, sessionService, promptService)
- **1 service file still in services/**: `llm.ts` (imports ProviderRegistry) — update to `../../domain/ai/provider-registry.ts`
- **1 service internal**: `assistant-resolver.ts` (imports promptService — now relative within domain/)
- **2 application-level files**: `agent.ts` (runWithContext, requireState, requireLogger, assistantResolverService, promptService), `orchestrator.ts` (sessionService, assistantResolverService)
- **2 entry points**: `server.ts` + `server.test.ts` (sessionService)

Note: `file.ts` was already fixed in Phase 1 — no longer imports session-context.

**After this phase**: `services/agent/` and `services/ai/` are deleted except for `llm.ts` (moved in Phase 3).

---

### Phase 3 — Adapters layer

**Goal**: Group external system integrations under `src/adapters/`.

**Files to move**:
- `providers/openai.ts` → `adapters/ai/openai.ts`
- `providers/gemini.ts` → `adapters/ai/gemini.ts`
- `services/ai/llm.ts` → `adapters/ai/llm.ts`
- Create `adapters/ai/index.ts` barrel

**Rationale for llm.ts placement**:
`llm.ts` creates a `ProviderRegistry` (domain) and populates it with concrete providers (openai, gemini). It's adapter wiring — it bridges the domain contract with external implementations. Not application-level because it doesn't coordinate use cases.

**Import updates required** (4 files):
- **3 tool files**: `think.ts`, `prompt_engineer.ts`, `document_processor.ts` — import `llm`, update to `../adapters/ai/llm.ts`
- **1 application-level file**: `agent.ts` — imports `llm` as `defaultLLM`, update to `./adapters/ai/llm.ts` (or `../adapters/ai/llm.ts` depending on whether agent.ts has moved yet — it hasn't, that's Phase 4)

**After this phase**: `src/providers/` is deleted. `services/ai/` is empty and deleted.

---

### Phase 4 — Application layer

**Goal**: Move use-case coordination into `src/application/`.

**Files to move**:
- `agent.ts` (from `src/` root) → `application/agent.ts`
- `services/agent/orchestrator.ts` → `application/orchestrator.ts`
- Create `application/index.ts` barrel

**Bootstrap wiring**: `orchestrator.ts` or a new `application/bootstrap.ts` calls:
```typescript
setSessionIdResolver(getSessionId);  // Wire infrastructure ← domain
```

**Import updates required** (3 files):
- `cli.ts` — imports `executeTurn`, update to `./application/orchestrator.ts`
- `server.ts` — imports `executeTurn`, update to `./application/orchestrator.ts`
- `orchestrator.ts` — imports `runAgent` from `../../agent.ts`, becomes relative `./agent.ts` (both now in application/)

**After this phase**: `src/services/` directory is fully deleted. No replacement barrel — all consumers import from specific layers.

**Final cleanup**:
- Delete `src/services/` directory entirely (should already be empty)
- Verify no stale import paths remain: `grep -r "services/" src/` and `grep -r "providers/" src/`
- Update `src/index.ts` if it re-exported from services (remove or redirect)

---

## Testing scenarios

- **Per-phase regression**: `bun test` passes after each phase — no phase leaves broken imports
- **Agent end-to-end**: `bun run agent "test"` completes a full tool-calling loop after each phase
- **Dependency rule verification** (after Phase 4):
  ```bash
  # Infrastructure must not import from domain, application, or adapters
  grep -r "from.*domain\|from.*application\|from.*adapters" src/infrastructure/
  # Domain must not import from application
  grep -r "from.*application" src/domain/
  # Should return zero matches
  ```
- **Import completeness**: `grep -r "services/" src/` and `grep -r "providers/" src/` return zero matches
- **Session-scoped output**: Run agent with `--session`, verify output files land in `output/{sessionId}/` (confirms setSessionIdResolver wiring works)
- **Test file co-location**: `document-store.test.ts` and `session.test.ts` moved alongside their source and still discovered by `bun test`

## Risk assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Import path typo breaks runtime but not typecheck | Medium | Run agent e2e after each phase, not just tests |
| Barrel re-exports create circular imports | Low | Keep barrels shallow (one level), no cross-layer barrels |
| `setSessionIdResolver` not called → output not session-scoped | Medium | Add startup assertion: warn if resolver is default when session context exists |
| Phase 2 import churn (20+ files) introduces merge conflicts with parallel work | High | Coordinate timing; do Phase 2 when no other large branches are open |
| `llm.ts` in adapters/ feels wrong to some — it uses domain types | Low | Documented rationale; it instantiates adapters, doesn't define contracts |
