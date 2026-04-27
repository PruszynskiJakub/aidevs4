# SP-85 Sandbox Symlink Resolution

> Security fix: **H1** from security audit 2026-04-09.

## Main objective

Replace `path.resolve()` with `fs.realpath()` in the sandbox's path
validation so that symlinks cannot be used to escape the sandbox boundary.

## Context

`src/infra/sandbox.ts` validates paths using `path.resolve()`:

```typescript
function assertPathAllowed(
  targetPath: string,
  allowedDirs: string[],
  blockedDirs: string[],
  operation: "read" | "write",
  sessionsDir: string,
): void {
  const resolved = resolve(targetPath);
  // ...
  const allowed = effective.some((dir) => {
    const resolvedDir = resolve(dir);
    return resolved === resolvedDir || resolved.startsWith(resolvedDir + "/");
  });
```

`path.resolve()` normalizes `..` and `.` components but does **not** follow
symlinks. If a symlink exists within an allowed directory that points outside
it, the sandbox check passes but the actual I/O operates on the target.

**Attack scenario**:
1. LLM uses `bash` tool to create a symlink:
   `ln -s /etc session_dir/escape`
2. LLM uses `read_file` on `session_dir/escape/passwd`
3. `resolve()` produces `session_dir/escape/passwd` — passes sandbox check
4. Actual read follows the symlink to `/etc/passwd` — sandbox escaped

**Prerequisite**: The attacker needs the ability to create symlinks inside
an allowed directory. This is possible via the `bash` tool (which runs in
the session directory) or the `execute_code` tool (if Deno is absent — see
SP-83).

## Out of scope

- Preventing symlink creation (that's a bash tool concern).
- Changing the sandbox allowlist/blocklist logic.
- Modifying the `fs.ts` raw layer.
- Performance optimization of realpath calls.

## Constraints

- No new runtime dependencies (use `node:fs/promises` `realpath`).
- `assertPathAllowed` must remain synchronous-callable from the sandbox
  methods. Since `realpath` is async, the assertion must become async or
  use `realpathSync`.
- Must handle the case where the target path **does not yet exist** (e.g.,
  `write` to a new file). In this case, resolve the **longest existing
  prefix** of the path and validate that.
- Must not break any existing tests.

## Design decision: sync vs async

The current `assertPathAllowed` is synchronous, called from every sandbox
method. Making it async would require making every sandbox method's
validation async (they already are async, but the assert is sync within
them). Two options:

**Option A**: Use `realpathSync` from `node:fs`. Synchronous, minimal code
change, but blocks the event loop briefly per call.

**Option B**: Make `assertPathAllowed` async, `await` it in every sandbox
method. More idiomatic but touches every method.

**Decision**: **Option A** (`realpathSync`). The sandbox methods already
call `resolve()` synchronously. `realpathSync` is a single syscall with
negligible latency on local filesystems. The code diff is minimal and the
risk of introducing bugs is lower.

## Changes

### 1. Add realpath resolution — `src/infra/sandbox.ts`

Add import:
```typescript
import { realpathSync } from "node:fs";
```

Add helper to resolve the real path, handling non-existent targets:
```typescript
/**
 * Resolve symlinks in a path. If the full path doesn't exist, walk up to
 * find the longest existing ancestor and resolve that, then re-append
 * the remaining segments. This handles writes to new files in symlinked dirs.
 */
function resolveReal(targetPath: string): string {
  const absolute = resolve(targetPath);
  try {
    return realpathSync(absolute);
  } catch {
    // Path doesn't exist yet — resolve the parent
    const parent = dirname(absolute);
    const base = basename(absolute);
    if (parent === absolute) return absolute; // filesystem root — stop
    return join(resolveReal(parent), base);
  }
}
```

### 2. Replace resolve() with resolveReal() in assertPathAllowed

**Current**:
```typescript
const resolved = resolve(targetPath);
```

**Target**:
```typescript
const resolved = resolveReal(targetPath);
```

Also resolve the allowed/blocked dirs through `resolveReal` (they are
static config paths that should never be symlinks, but defense in depth):

**Current**:
```typescript
const allowed = effective.some((dir) => {
  const resolvedDir = resolve(dir);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + "/");
});
```

**Target**:
```typescript
const allowed = effective.some((dir) => {
  const resolvedDir = resolveReal(dir);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + "/");
});
```

Same change for the `blockedDirs` check.

### 3. Add dirname/basename imports — `src/infra/sandbox.ts`

Update the import:
```typescript
import { resolve, relative, dirname, basename, join } from "path";
```

(`join` is already used indirectly through `narrowOutputPaths` if needed;
`dirname` and `basename` are new.)

## Test plan

1. **Symlink attack**: Create a temp directory structure:
   ```
   /tmp/sandbox-test/allowed/
   /tmp/sandbox-test/allowed/legit.txt
   /tmp/sandbox-test/allowed/evil -> /tmp/sandbox-test/secret/
   /tmp/sandbox-test/secret/data.txt
   ```
   Create a sandbox with `readPaths: ["/tmp/sandbox-test/allowed/"]`.
   - `readText("allowed/legit.txt")` — should succeed.
   - `readText("allowed/evil/data.txt")` — should throw access denied
     (resolved real path is `/tmp/sandbox-test/secret/data.txt`).

2. **Write to new file in real dir**: Sandbox with
   `writePaths: ["/tmp/sandbox-test/allowed/"]`.
   - `write("allowed/new.txt", "data")` — should succeed (parent exists
     and is real).

3. **Write to new file via symlinked parent**:
   - `write("allowed/evil/new.txt", "data")` — should throw (parent
     resolves outside allowed path).

4. **Existing tests**: `bun test src/infra/sandbox` passes.

5. **Performance**: Measure `realpathSync` overhead on 1000 calls — expect
   < 50ms total (single syscall per call, local fs).
