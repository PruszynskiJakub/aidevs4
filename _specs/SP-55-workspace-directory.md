# SP-55 Workspace Directory

## Main objective

Unify output, logs, and agent artifacts under a single `workspace/` directory so that everything about a session lives together, agents can share files within a session, and the system is ready for multi-agent orchestration.

## Context

Today the project scatters session data across three top-level directories:

| What | Current path | Base constant |
|------|-------------|---------------|
| Tool outputs | `output/{sessionId}/{fileType}/{uuid}/{file}` | `OUTPUT_DIR` |
| Markdown logs | `logs/{YYYY-MM-DD}/{sessionId}/log_*.md` | `LOGS_DIR` |
| JSONL events | `logs/{YYYY-MM-DD}/{sessionId}/events.jsonl` | `LOGS_DIR` |
| Agent defs | `workspace/agents/*.agent.md` | hardcoded in `agents.ts` |

Problems:
- **No co-location** — understanding a session requires looking in two places (`output/` and `logs/`)
- **No agent-level isolation** — all agents in a session dump into the same output bucket
- **No inter-agent communication** — no conventional place for agent A to leave artifacts for agent B
- **No workspace discovery** — no single root to introspect sessions, agents, shared state

### Target structure

```
workspace/
  agents/                              # already exists (.agent.md files)
  shared/                              # human-AI communication layer (empty initially)
  sessions/
    {YYYY-MM-DD}/
      {sessionId}/
        log/                           # markdown + JSONL (replaces logs/)
          log_HH-mm-ss.md
          events.jsonl
        shared/                        # free-form inter-agent file dump
        {agentName}/
          output/                      # that agent's artifacts
            {fileType}/
              {uuid}/
                {filename}
```

### Key decisions (aligned with user)

1. **Date bucketing in session path** — `sessions/{YYYY-MM-DD}/{sessionId}/` gives both date-based and session-based browsing in one path
2. **Session `shared/`** — starts as free-form file dump; structure emerges from usage
3. **Global `shared/`** — human-AI interface layer (tasks.md, cron signals, etc.); left empty initially
4. **Hard cutover** — no backward compatibility with old `output/` and `logs/` paths; old data stays in place
5. **No manifest** — directory structure is the discovery mechanism; add manifest later if needed

## Out of scope

- Migration of existing sessions from `output/` and `logs/` to the new layout
- Schema or conventions for session `shared/` contents
- Contents of global `workspace/shared/`
- Workspace discovery API / tooling (future spec)
- Multi-agent orchestrator changes (this spec only lays the directory foundation)

## Constraints

- `workspace/agents/` already exists with `.agent.md` files — must not break agent loading
- Sandbox narrowing must still prevent cross-session writes
- `toSessionPath()` / `resolveSessionPath()` must continue to produce token-efficient relative paths for LLM context
- All file I/O must go through `FileProvider` — no raw `fs` / `Bun.file()`

## Acceptance criteria

- [ ] All new session output files land under `workspace/sessions/{YYYY-MM-DD}/{sessionId}/{agentName}/output/`
- [ ] All new log files (markdown + JSONL) land under `workspace/sessions/{YYYY-MM-DD}/{sessionId}/log/`
- [ ] `workspace/shared/` directory is created (empty)
- [ ] `workspace/agents/` continues to work unchanged
- [ ] Sandbox write paths cover `workspace/sessions/` instead of `output/` and `logs/`
- [ ] Sandbox narrowing scopes writes to the active session's directory
- [ ] `toSessionPath()` returns paths relative to the session root (not just the output subdir)
- [ ] `resolveSessionPath()` correctly resolves relative paths back to absolute
- [ ] Agent context carries `agentName` so output paths include per-agent directories
- [ ] `CLAUDE.md` project structure section is updated
- [ ] All existing tests pass or are updated to reflect new paths
- [ ] New tests cover the changed path logic in session service, loggers, and file sandbox

## Implementation plan

1. **Update `src/config/paths.ts`**
   - Add `WORKSPACE_DIR = join(PROJECT_ROOT, "workspace")`
   - Add `SESSIONS_DIR = join(WORKSPACE_DIR, "sessions")`
   - Remove `OUTPUT_DIR` and `LOGS_DIR` (or keep as deprecated aliases if anything outside `src/` references them)

2. **Update `src/config/index.ts`**
   - Replace `config.paths.outputDir` and `config.paths.logsDir` with `config.paths.workspaceDir` and `config.paths.sessionsDir`
   - Update `config.sandbox.allowedWritePaths` to `[SESSIONS_DIR, join(WORKSPACE_DIR, "shared")]`

3. **Add `agentName` to session context**
   - Extend `AgentState` in context with optional `agentName` field
   - Expose `getAgentId()` from `src/agent/context.ts`
   - Default to `"default"` when no agentName is set

4. **Rewrite `src/agent/session.ts`**
   - `sessionDir()` → `workspace/sessions/{YYYY-MM-DD}/{sessionId}`
   - `outputPath(filename)` → `{sessionDir}/{agentName}/output/{fileType}/{uuid}/{filename}`
   - `logDir()` → `{sessionDir}/log/`
   - `sharedDir()` → `{sessionDir}/shared/`
   - `toSessionPath(abs)` → strip up to `{sessionId}/` prefix, return rest
   - `resolveSessionPath(rel)` → prepend session dir
   - `ensureOutputDir()` → create session dir tree

5. **Update `src/infra/log/markdown.ts`**
   - Accept session dir path instead of constructing from `logsDir + date + sessionId`
   - Write to `{sessionDir}/log/log_{HH-mm-ss}.md`
   - Sidecar files go to same `log/` directory

6. **Update `src/infra/log/jsonl.ts`**
   - `defaultPathFn` → `{sessionDir}/log/events.jsonl`

7. **Update `src/infra/file.ts`**
   - `narrowOutputPaths()` → narrow `SESSIONS_DIR` to `SESSIONS_DIR/{date}/{sessionId}`
   - Update `allowedWritePaths` default

8. **Create `workspace/shared/` directory**
   - Add `.gitkeep` so it's tracked

9. **Update `CLAUDE.md`**
   - Reflect new project structure

10. **Update tests**
    - `session.test.ts` — new path assertions
    - `markdown.test.ts` / `jsonl.test.ts` — new log paths
    - `file.test.ts` — new sandbox paths

## Testing scenarios

- **Output path generation**: call `outputPath("photo.png")` with session `abc` on `2026-03-26` with agent `default` → path matches `workspace/sessions/2026-03-26/abc/default/output/image/{uuid}/photo.png`
- **Log path generation**: create MarkdownLogger with session `abc` on `2026-03-26` → log file under `workspace/sessions/2026-03-26/abc/log/log_*.md`
- **JSONL path generation**: emit event with session `abc` on `2026-03-26` → written to `workspace/sessions/2026-03-26/abc/log/events.jsonl`
- **Session path roundtrip**: `resolveSessionPath(toSessionPath(absolutePath))` returns the original absolute path
- **Sandbox narrowing**: with active session, writes to other sessions' dirs are rejected
- **Sandbox allows shared**: writes to `workspace/shared/` succeed regardless of session
- **Agent isolation**: two agents in same session produce output in separate `{agentName}/output/` dirs
- **Agent loading**: `workspace/agents/*.agent.md` loading is unaffected
- **No session context**: fallback UUID is used, output still lands under `workspace/sessions/{date}/{fallbackId}/`
