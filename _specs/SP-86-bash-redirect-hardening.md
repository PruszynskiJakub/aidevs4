# SP-86 Bash Redirect Parsing Hardening

> Security fix: **H2** from security audit 2026-04-09.

## Main objective

Harden the bash tool's write-target validation to catch redirect patterns
that the current regex-based parser misses, preventing writes outside the
session directory.

## Context

`src/tools/bash.ts:25-42` validates that redirect targets stay within the
session CWD:

```typescript
function assertWritesInSessionDir(command: string, cwd: string): void {
  const redirectTargets = [
    ...command.matchAll(/>{1,2}\s*([^\s;&|]+)/g),
    ...command.matchAll(/\btee\s+(?:-[a-z]\s+)*([^\s;&|]+)/g),
  ].map((m) => m[1]);

  for (const target of redirectTargets) {
    if (target.startsWith("/dev/")) continue;
    const resolved = resolve(cwd, target);
    if (!resolved.startsWith(cwd + "/") && resolved !== cwd) {
      throw new Error(`Write target "${target}" resolves to "${resolved}" ...`);
    }
  }
}
```

This catches `> /tmp/evil` and `>> ../escape` but misses:

1. **`exec` fd redirection**: `exec 3>/etc/passwd; echo data >&3`
2. **Process substitution**: `cat > >(tee /etc/passwd)`
3. **Here-doc with redirect**: `cat << EOF > /etc/passwd`
4. **Command substitution in target**: `cat > $(echo /etc/passwd)`
5. **Backtick substitution**: `` cat > `/bin/echo /etc/passwd` ``
6. **dd output**: `dd if=/dev/zero of=/etc/passwd`
7. **install/cp/mv to absolute paths**: `cp data /etc/passwd`

Regex-based parsing of bash syntax is fundamentally incomplete. Bash's
grammar is context-sensitive and ambiguous — you cannot reliably parse it
with regular expressions.

## Out of scope

- Replacing bash with a restricted shell (long-term improvement).
- Sandboxing bash via Docker/firejail/bubblewrap.
- Changing the session directory structure.
- Modifying other tools' command execution.

## Constraints

- No new runtime dependencies.
- Must not break legitimate bash usage (downloads, jq, awk, etc.).
- False positives are acceptable for dangerous patterns — better to reject
  a valid command than allow a sandbox escape.
- Must not break existing tests.

## Design decision: regex expansion vs pattern blocklist

**Option A**: Expand the regex set to catch more redirect syntaxes. This is
an arms race — every new bash feature introduces new bypass vectors. The
regex approach is fundamentally unsound.

**Option B**: Keep the existing redirect regex AND add a blocklist of
dangerous bash patterns/builtins. If a command contains a blocked pattern,
reject it entirely. This is defense in depth — the redirect check catches
the common case, the blocklist catches the exotic escapes.

**Decision**: **Option B** — layered defense. The blocklist is strict but
covers the realistic attack surface. Legitimate agent commands (curl, jq,
unzip, wget, awk, sort, wc, file) never use `exec`, process substitution,
or dd.

## Changes

### 1. Add pattern blocklist — `src/tools/bash.ts`

Add after the existing `assertWritesInSessionDir`:

```typescript
/**
 * Reject bash syntax that can write to arbitrary locations in ways
 * the redirect-target parser cannot reliably detect.
 */
const BLOCKED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bexec\s+\d*[<>]/, reason: "exec with file descriptor redirection" },
  { pattern: /\bexec\s+\{[^}]+\}[<>]/, reason: "exec with named fd redirection" },
  { pattern: />\s*>\s*\(/, reason: "process substitution as write target" },
  { pattern: />\s*\$\(/, reason: "command substitution in redirect target" },
  { pattern: />\s*`/, reason: "backtick substitution in redirect target" },
  { pattern: /\bdd\b.*\bof=/, reason: "dd with output file" },
  { pattern: /\bmkfifo\b/, reason: "named pipe creation" },
  { pattern: /\bln\s+-[^-]*s/, reason: "symbolic link creation" },
  { pattern: /\bln\s+--symbolic\b/, reason: "symbolic link creation" },
];

function assertNoDangerousPatterns(command: string): void {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(
        `Command blocked: contains ${reason}. ` +
        `This pattern can write outside the session directory and is not allowed.`
      );
    }
  }
}
```

### 2. Add absolute path check for write commands — `src/tools/bash.ts`

Catch common file-writing commands that take an output path argument:

```typescript
/**
 * Check commands that write to a path argument (not via shell redirect).
 * Block if the target is absolute and outside CWD.
 */
const WRITE_COMMANDS: RegExp[] = [
  /\bcp\s+.*\s+(\/\S+)/,       // cp ... /absolute/target
  /\bmv\s+.*\s+(\/\S+)/,       // mv ... /absolute/target
  /\binstall\s+.*\s+(\/\S+)/,  // install ... /absolute/target
];

function assertWriteCommandTargets(command: string, cwd: string): void {
  for (const re of WRITE_COMMANDS) {
    const match = command.match(re);
    if (!match) continue;
    const target = match[1];
    if (target.startsWith("/dev/")) continue;
    const resolved = resolve(cwd, target);
    if (!resolved.startsWith(cwd + "/") && resolved !== cwd) {
      throw new Error(
        `Command blocked: write target "${target}" is outside the session directory.`
      );
    }
  }
}
```

### 3. Wire new checks into handler — `src/tools/bash.ts`

**Current** (line 52):
```typescript
assertWritesInSessionDir(command, cwd);
```

**Target**:
```typescript
assertNoDangerousPatterns(command);
assertWritesInSessionDir(command, cwd);
assertWriteCommandTargets(command, cwd);
```

Order matters: the blocklist rejects dangerous patterns first (cheap regex
check), then the redirect parser validates targets, then the write-command
checker validates argument-based targets.

### 4. Block symlink creation (defense for SP-85)

The `ln -s` blocklist entry (in step 1) also defends against the symlink
attack vector from SP-85. If an attacker can't create symlinks via bash,
the symlink sandbox escape in SP-85 becomes much harder to exploit. These
two specs are complementary.

## Test plan

1. **Blocked patterns**: Verify `bash` throws for each:
   - `exec 3>/etc/passwd; echo secret >&3`
   - `echo data > >(tee /etc/passwd)`
   - `echo data > $(echo /etc/passwd)`
   - `` echo data > `/bin/echo /etc/passwd` ``
   - `dd if=/dev/zero of=/tmp/evil bs=1M count=1`
   - `ln -s /etc evil_link`
   - `ln --symbolic /etc evil_link`
   - `mkfifo /tmp/pipe`
   - `cp secret.txt /tmp/exfil.txt`
   - `mv secret.txt /etc/cron.d/evil`

2. **Allowed commands**: Verify these still work:
   - `curl -o data.json https://example.com/api`
   - `jq '.items[]' data.json > filtered.json`
   - `cat file.txt | sort | uniq > result.txt`
   - `unzip archive.zip -d ./extracted/`
   - `wc -l *.txt`
   - `echo "hello" > ./output.txt`
   - `echo "append" >> ./log.txt`
   - `tee ./copy.txt < input.txt`
   - `cp file1.txt ./backup/file1.txt` (relative target — allowed)
   - `mv old.txt ./new.txt` (relative target — allowed)

3. **Existing tests**: `bun test src/tools/bash` passes.

4. **Edge cases**:
   - Command with `exec` as substring in a word (e.g., `executor`): must
     NOT be blocked (regex uses `\b` word boundary).
   - `dd if=input.json of=./local.bin`: relative target inside CWD —
     should be blocked by the `dd` pattern (conservative; `dd` is rarely
     needed by the agent and the risk outweighs the utility).
