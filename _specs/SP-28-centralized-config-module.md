# SP-28 Centralized config module

## Main objective

Replace the flat `src/config.ts` constants file with a validated, singleton config module (`src/config/index.ts`) that loads all environment variables and static settings at import time, fails fast on missing required values, and exports a single frozen object used everywhere.

## Context

Today `src/config.ts` is a bag of `export const` values — paths, model names, timeouts, limits, and a lazy API-key resolver. Environment variables (`HUB_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `PORT`, `PERSONA`) are read ad-hoc across 6+ files with inconsistent validation: some throw lazily, some silently default, some are never checked. There are 18 files that import from `config.ts`.

A `src/config/` directory already exists (contains `personas.ts`). The new module will live alongside it.

Problems this solves:
- **No startup validation** — missing keys surface as runtime errors minutes into an agent run.
- **Scattered `process.env` reads** — hard to audit what the system needs.
- **No grouping** — 20+ flat constants with no logical structure.
- **No singleton** — config values are module-level constants, but secrets are fetched per-call.

## Out of scope

- Changing any config *values* (models, timeouts, URLs stay the same)
- Adding new config keys not currently in use
- Moving `personas.ts` — it stays in `src/config/` as-is
- Runtime config reloading or watching `.env` for changes
- Config override via CLI flags or config files (YAML, TOML, etc.)

## Constraints

- Bun runtime — use Bun-native APIs where applicable (Bun auto-loads `.env`)
- Zero new dependencies — validation logic is hand-written, no `zod` / `joi`
- All 18 existing importers must be updated in this PR — no dual export period
- The frozen config object must be deeply immutable (arrays too)
- `import.meta.dir`-based path resolution must remain correct after the file moves from `src/config.ts` to `src/config/index.ts`

## Acceptance criteria

- [ ] `src/config.ts` is deleted; `src/config/index.ts` exports a singleton `config` object
- [ ] All environment variables (`HUB_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `PORT`, `PERSONA`) are read in `config/index.ts` — no `process.env` reads remain elsewhere in `src/`
- [ ] Required env vars (`HUB_API_KEY`, `OPENAI_API_KEY`) cause a clear, immediate error at import time if missing
- [ ] Optional env vars (`GEMINI_API_KEY`, `PORT`, `PERSONA`) use typed defaults (undefined / 3000 / undefined) and do not throw
- [ ] The exported object is deeply frozen — mutating any property or pushing to any array throws at runtime
- [ ] All 18 importing files are updated to `import { config } from "./config"` (or appropriate relative path) and reference `config.<group>.<key>`
- [ ] Existing tests pass without modification to assertions (only import paths change)
- [ ] A new `src/config/index.test.ts` covers: required var missing → throws, optional var missing → defaults, object is frozen, all keys present when env is valid
- [ ] `bun test` passes, `bun run agent "ping"` starts without error

## Implementation plan

1. **Design the config shape** — define a `Config` type with logical groups:
   ```ts
   interface Config {
     paths: { projectRoot, outputDir, logsDir }
     sandbox: { allowedReadPaths, allowedWritePaths, webAllowedHosts }
     models: { agent, transform, gemini }
     hub: { baseUrl, verifyUrl, apiKey }
     limits: { maxIterations, fetchTimeout, maxBatchRows, maxFileSize, transformBatchSize, geminiTimeout, docMaxFiles }
     web: { placeholderMap }
     server: { port }
     persona: string | undefined
   }
   ```

2. **Create `src/config/index.ts`** — single file that:
   - Reads all `process.env` values
   - Validates required ones (throws with a list of all missing vars, not just the first)
   - Computes derived values (paths via `join`/`resolve`, composed URLs)
   - Builds the config object
   - Deep-freezes it
   - Exports `config` as the default and named export

3. **Update all 18 importers** — mechanical find-and-replace:
   - `import { FOO } from "./config"` → `import { config } from "./config"`
   - `FOO` → `config.group.foo`
   - For test files that mock env vars, adjust setup/teardown if needed

4. **Remove scattered `process.env` reads** — update:
   - `src/utils/hub.ts` (`HUB_API_KEY`) → use `config.hub.apiKey`
   - `src/services/llm.ts` (`GEMINI_API_KEY`) → use `config.models.geminiApiKey` or similar
   - `src/agent.ts` (`PERSONA`) → use `config.persona`
   - `src/server.ts` (`PERSONA`, `PORT`) → use `config.persona`, `config.server.port`

5. **Delete `src/config.ts`** — the old flat file

6. **Write `src/config/index.test.ts`** — test validation, defaults, freezing

7. **Verify** — run `bun test` and `bun run agent "ping"` to confirm everything works

## Testing scenarios

- **Required var missing**: unset `HUB_API_KEY`, import config → expect thrown error mentioning the variable name
- **All required vars set**: set `HUB_API_KEY` + `OPENAI_API_KEY` → config loads, all keys present with correct values
- **Optional var missing**: unset `GEMINI_API_KEY` → `config.models.geminiApiKey` is `undefined`, no throw
- **PORT default**: unset `PORT` → `config.server.port` is `3000`
- **Deep freeze**: attempt `config.limits.maxIterations = 99` → throws TypeError
- **Array freeze**: attempt `config.sandbox.allowedReadPaths.push("/tmp")` → throws TypeError
- **Path correctness**: `config.paths.projectRoot` resolves to the repo root (same value as before the refactor)
