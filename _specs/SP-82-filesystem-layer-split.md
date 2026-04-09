# SP-82 Filesystem Layer Split

> Supersedes: SP-04 (File Service Sandbox) — refactors the sandbox it built.

## Main objective

Split the monolithic `FileProvider` into two layers — a raw `fs.ts` for
infrastructure code and a `sandbox.ts` for LLM-facing tool handlers — so that
the sandbox is enforceable, the write scope matches what the agent is actually
told it can do, and all production code goes through a single auditable import.

## Context

The current `src/infra/file.ts` tries to serve both infrastructure (logging,
config loading, OAuth, DB) and LLM-controlled tool handlers through one
singleton with a single read/write allowlist. This creates three problems:

1. **Infra bypasses it.** Forcing config loaders and loggers through an
   LLM-targeted sandbox is awkward, so `mcp-oauth.ts`, `jsonl.ts`,
   `agents.ts`, `db/connection.ts`, `execute_code.ts`, and `browser.ts` all
   use raw `fs`/`Bun.file`/`Bun.write` directly — making the "never use raw
   fs" rule unenforceable.

2. **The write allowlist is wrong.** Config says writes go to
   `[sessions/, shared/, browser/]`, but the agent system prompt instructs
   writing to `knowledge/`, `scratch/`, `workflows/`. The config is frozen at
   startup and never widened, so the agent literally cannot do what it's told.

3. **Hardcoded paths everywhere.** Seven modules construct paths via
   `resolve(import.meta.dir, "../../...")` instead of `config.paths.*`.
   `config.paths` only exposes 3 paths (`projectRoot`, `workspaceDir`,
   `sessionsDir`); everything else is ad-hoc.

Additionally, tools that accept file paths from the LLM (`agents_hub`,
`geo_distance`, `document_processor`) rely solely on the sandbox allowlist
with no input-level validation (`safeFilename`/`basename`). One layer of
defense.

**Security posture change:** This spec intentionally relaxes the write scope
from a narrow allowlist (`sessions/`, `shared/`, `browser/`) to a broad
blocklist (everything under `workspace/` except `system/`). This matches
what the agent is already instructed to do but was silently blocked from
doing. The trade-off is accepted: `system/` (agent definitions, skills,
MCP config) stays read-only; everything else is writable by design.

## Out of scope

- Playground scripts — may use raw `fs`/`Bun` freely.
- Test files — may use raw `fs/promises` for temp dirs and fixtures.
- Network I/O sandboxing (web allowlists, fetch timeouts).
- Changing tool behavior or schemas beyond wiring to the new fs layers.
- `workspace.ts` navigation instructions content (only path constants move).

## Constraints

- No new runtime dependencies.
- Zero breaking changes to tool handler runtime behavior (import paths will
  change but API surface stays the same).
- All existing tests must pass (import paths may need updating).
- The sandbox write policy inverts to a **blocklist**: writes allowed anywhere
  under `workspaceDir` **except** `workspace/system/` (read-only, contains
  agent definitions, skills, MCP config). Reads allowed from `projectRoot`.
- `config` object remains `deepFreeze`'d at startup.
- `execute_code` sandbox bridge remains the tightest scope (session-dir only)
  — it creates its own sandbox instance, unaffected by the default policy.

## Acceptance criteria

- [ ] `src/infra/fs.ts` exists: thin wrapper over `Bun.file`/`Bun.write`/
      `node:fs`, no access control. Exports: `readText`, `readBinary`,
      `readJson`, `write`, `append`, `readdir`, `stat`, `exists`, `mkdir`,
      `unlink`, `rename`, `checkFileSize`. No singleton — pure functions.
- [ ] `src/infra/sandbox.ts` exists: wraps `fs.ts` with allowlist/blocklist
      enforcement. Exports a `createSandbox(opts)` factory and a default
      `sandbox` singleton. Used by all tool handlers. Also exports
      `FileSizeLimitError` and a `_setSandboxForTest()` helper (replaces
      `_setFilesForTest`).
- [ ] Sandbox write policy: allowed anywhere under `workspaceDir` except
      `workspace/system/**` (blocked). Reads: `projectRoot` and below.
      Path matching uses `resolve()` + trailing-slash-aware prefix check
      to prevent false positives (e.g. `system_backup/` must not match
      `system/`).
- [ ] `config/paths.ts` exports all well-known directories: `dataDir`,
      `promptsDir`, `agentsDir`, `knowledgeDir`, `scratchDir`, `workflowsDir`,
      `browserDir`, `mcpOauthDir`, `mcpConfigPath`. No production module in
      `src/` constructs paths via `import.meta.dir` relative traversal.
- [ ] All infra modules (`mcp-oauth.ts`, `db/connection.ts`, `jsonl.ts`,
      `agents.ts`, `mcp.ts`, `browser.ts`, `prompt.ts`, `evals/runner.ts`)
      import from `fs.ts` instead of raw `node:fs`, `fs/promises`,
      `Bun.file()`, or `Bun.write()`. Paths come from `config.paths.*`.
- [ ] `execute_code.ts` uses `fs.ts` for temp file lifecycle (`write`,
      `unlink`, `mkdir`) instead of raw imports.
- [ ] Tools accepting LLM-provided file paths (`agents_hub`, `geo_distance`,
      `document_processor`) validate path input before passing to sandbox:
      reject `..` components, reject chars outside `[a-zA-Z0-9_.\-/]`,
      enforce max length via `assertMaxLength()`. (Note: `safeFilename()`
      rejects `/` so cannot be used for full paths — use per-component
      validation or a new `safePath()` helper.)
- [ ] `workspace.ts` path constants are removed; `workspace.ts` itself uses
      `config.paths.*` (it is the only consumer of those constants).
- [ ] `src/types/file.ts` `FileProvider` interface is updated: drop
      `resolveInput`, add `unlink`/`rename`. `checkFileSize` stays (moved
      to `fs.ts` as a pure function, re-exported through sandbox).
- [ ] Old `src/infra/file.ts` is deleted. No production code imports it.
- [ ] `resolveInput()` is removed from the file interface and moved into the
      specific tool handler(s) that need it.
- [ ] All existing tests pass (with updated imports).
- [ ] New unit tests cover: sandbox read allow/deny, write allow/deny,
      `system/` write block, `../` traversal, boundary paths (trailing-slash),
      `createSandbox()` with custom config, `_setSandboxForTest()` swap.

## Implementation plan

Steps 1–2 are independent and can be done in parallel. Steps 4–7 are
independent of each other (all depend on step 3) and can be parallelized.

1. **Expand `config/paths.ts`** _(parallel with 2)_
   Add all well-known directory constants: `DATA_DIR`, `PROMPTS_DIR`,
   `AGENTS_DIR`, `KNOWLEDGE_DIR`, `SCRATCH_DIR`, `WORKFLOWS_DIR`,
   `BROWSER_DIR`, `MCP_OAUTH_DIR`, `MCP_CONFIG_PATH`, `SYSTEM_DIR`. Wire
   into `config.paths` in `config/index.ts`. Update `config.sandbox` to use
   blocklist model: `blockedWritePaths: [SYSTEM_DIR]` replacing
   `allowedWritePaths`.

2. **Create `src/infra/fs.ts`** _(parallel with 1)_
   Thin wrapper: each function takes an absolute path, calls `Bun.file` /
   `Bun.write` / `node:fs`. No access checks. Includes `unlink`, `rename`,
   and `checkFileSize` (missing from current interface). Pure functions, no
   singleton state.

3. **Create `src/infra/sandbox.ts`** _(depends on 1 + 2)_
   - `createSandbox({ readPaths, writePaths, blockedWritePaths })` factory.
   - Each method validates path via `assertPathAllowed()` (using `resolve()`
     + trailing-slash-aware prefix matching) then delegates to `fs.ts`.
   - Default singleton uses config: reads from `projectRoot`, writes to
     `workspaceDir` except `system/`.
   - Per-session narrowing moves here (from old `narrowOutputPaths`).
   - Implements updated `FileProvider` interface for `sessionService` DI.
   - Exports `FileSizeLimitError` and `_setSandboxForTest()`.

4. **Migrate infra modules to `fs.ts`** _(parallel with 5, 6, 7)_
   Update imports in: `mcp-oauth.ts`, `db/connection.ts`, `jsonl.ts`,
   `agents.ts`, `mcp.ts`, `browser.ts`, `prompt.ts`, `evals/runner.ts`,
   `execute_code.ts`. Replace raw `fs`/`Bun` calls with `fs.ts` functions.
   Replace hardcoded paths with `config.paths.*`.

5. **Migrate tool handlers to `sandbox.ts`** _(parallel with 4, 6, 7)_
   Update imports in all `src/tools/*.ts` from `../infra/file.ts` to
   `../infra/sandbox.ts`. The API surface is identical (`readText`, `write`,
   etc.) so changes are mechanical.

6. **Add input validation to path-accepting tools** _(parallel with 4, 5, 7)_
   In `agents_hub.ts`, `geo_distance.ts`, `document_processor.ts`: validate
   LLM-provided file path arguments — reject `..` components, validate
   character set per component, enforce max length via `assertMaxLength()`.
   (`safeFilename()` rejects `/` so use per-component splitting or a new
   `safePath()` utility.)

7. **Remove `workspace.ts` path constants** _(parallel with 4, 5, 6)_
   Move `workspace.knowledge.root`, etc. into `config.paths`. Update
   `workspace.ts` itself (only consumer of those constants). Keep
   `WORKSPACE_NAV_INSTRUCTIONS` and `buildWorkspaceContext()` in
   `workspace.ts` (prompt content, not path config).

8. **Delete `src/infra/file.ts`** _(depends on 4 + 5 + 7)_
   Remove old module. Grep for any remaining imports. Replace
   `_setFilesForTest` with `_setSandboxForTest` in all test files.

9. **Update tests** _(depends on 8)_
   - Fix import paths in all test files.
   - Add `src/infra/sandbox.test.ts`: read allow/deny, write allow/deny,
     `system/` block, traversal, boundary (trailing-slash), custom config,
     `_setSandboxForTest()` swap.
   - Add `src/infra/fs.test.ts`: basic read/write/unlink/rename smoke tests.
   - Verify all existing tests pass.

## Testing scenarios

| # | Scenario | Verify |
|---|----------|--------|
| 1 | Read file inside `projectRoot` via sandbox | Returns content |
| 2 | Read file outside `projectRoot` via sandbox (e.g. `/etc/passwd`) | Throws access denied |
| 3 | Write file to `workspace/knowledge/` via sandbox | Succeeds |
| 4 | Write file to `workspace/scratch/` via sandbox | Succeeds |
| 5 | Write file to `workspace/system/agents/` via sandbox | Throws access denied (blocked) |
| 6 | Write file to `workspace/system/mcp.json` via sandbox | Throws access denied (blocked) |
| 7 | Path traversal `workspace/knowledge/../../etc/passwd` | Resolves, throws access denied |
| 8 | Boundary: `workspace/system_backup/file.txt` (not `system/`) | Allowed (prefix check uses `/`) |
| 9 | `createSandbox()` with session-only write scope | Only session dir is writable |
| 10 | Infra module reads config via `fs.ts` (no sandbox) | Works without access checks |
| 11 | Tool with LLM path input containing `../` | Rejected at input validation layer before reaching sandbox |
| 12 | `execute_code` bridge sandbox: write outside session dir | Denied by bridge's narrow sandbox |
| 13 | All existing tool tests | Pass with updated imports |