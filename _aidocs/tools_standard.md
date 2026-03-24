# AI Tool Development Standard

Standard for building tools exposed to LLM agents. Every tool in `src/tools/`
MUST comply.

**Core assumption:** the LLM is untrusted. It may be compromised via prompt
injection, hallucinate arguments, or chain tools in unintended ways. Tools must
be safe *by construction*, not by relying on the model's good behaviour.

---

## 1. Tool Design Philosophy

Design tools for an operator who has **zero documentation** and **limited
attention span**. The model sees only names, descriptions, and schemas.

### 1.1 Naming

- Names must be **unique and unambiguous**: `send_email` not `send`.
- Use `snake_case`. Prefix domain when risk of collision exists:
  `hub_download`, `hub_verify`.
- Multi-action tools expose `${tool}__${action}` via the dispatcher — each
  action name must be self-explanatory on its own.

### 1.2 Descriptions (Signal-to-Noise)

- Keep descriptions **concise** — only information that helps the model pick
  the right tool at the right moment.
- Do NOT describe internal implementation, file paths, or infrastructure.
- Do NOT encourage dangerous patterns (shell redirects, pipes, wildcards).
- DO include: what the tool does, when to use it, what it returns.

### 1.3 Consolidate Actions (10-15 Tool Limit)

- A single agent should have **at most 10-15 tools**. More dilutes attention.
- Merge related API calls into one multi-action tool rather than exposing each
  endpoint separately (e.g., `workspace_metadata` that returns teams + labels +
  statuses in one call instead of three separate tools).
- Only expose actions the agent **actually needs**. If an action is used once
  a month, leave it out — do it manually.

### 1.4 Model vs. Code Responsibilities

For every parameter, ask three questions:

| Question                              | Action                                     |
| ------------------------------------- | ------------------------------------------ |
| Must the model fill this?             | Include in schema as `required`            |
| Should code fill this automatically?  | Inject in handler (e.g., `apikey`, user ID, timestamps) |
| Can the model NOT fill this reliably? | Never expose — hardcode or derive in code  |

Never let the model control: authentication tokens, user IDs that gate
permissions, internal record IDs it can't know.

---

## 2. Input Validation

LLM-provided arguments are **untrusted user input**. Validate everything.

### 2.1 Safe JSON Parsing

Never call `JSON.parse()` raw. Use the helper:

```typescript
function safeParse<T>(json: string, label: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`Invalid JSON in "${label}"`);
  }
}
```

- `label` identifies the field in the error (never echo the raw input back).
- Provide this as a shared utility in `src/utils/parse.ts`.

### 2.2 String Constraints

Every string parameter must declare and enforce:

| Constraint     | How                                      |
| -------------- | ---------------------------------------- |
| Max length     | `if (s.length > MAX) throw …`            |
| Allowed chars  | Regex allowlist: `/^[a-zA-Z0-9_.\-]+$/`  |
| No path escape | Reject if contains `..` or starts with `/` |

Apply the **strictest allowlist** that still works. Prefer allowlists over
blocklists — you can't enumerate every dangerous character.

### 2.3 Filename Parameters

Filenames are a special case — always sanitize:

```typescript
import { basename } from "path";

function safeFilename(raw: string): string {
  const name = basename(raw);
  if (name !== raw) throw new Error("Path separators not allowed in filename");
  if (!/^[a-zA-Z0-9_.\-]+$/.test(name)) throw new Error("Invalid filename characters");
  if (name.startsWith(".")) throw new Error("Hidden files not allowed");
  return name;
}
```

Even though the file service has path traversal protection, **defense in depth**
means we validate at the tool layer too.

### 2.4 Object Key Validation (Prototype Pollution)

When accepting objects whose keys come from LLM input (e.g., field maps):

```typescript
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function validateKeys(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (BANNED_KEYS.has(key)) throw new Error(`Forbidden key: ${key}`);
  }
}
```

### 2.5 Numeric Parameters

- Enforce min/max bounds in both the schema AND the handler.
- Parse as `Number()`, reject `NaN` / `Infinity`.

### 2.6 Forgiveness & Fuzzy Matching

The model will make small mistakes. Where safe, **tolerate and correct** instead
of hard-failing:

- Typos in enum values: `"done"` → suggest `"Did you mean 'completed'?"`
- Accept identifiers by name OR by ID when unambiguous.
- Auto-trim whitespace, normalize casing for lookups.

Only apply forgiveness to **non-destructive read-path** operations. Write-path
operations must be strict.

---

## 3. Sandboxing & Least Privilege

### 3.1 No Shell Access

**Do not expose a general-purpose shell to the agent.**

If a tool needs to run an external process, use one of these patterns
(from safest to least safe):

| Level | Pattern                         | Example                        |
| ----- | ------------------------------- | ------------------------------ |
| 1     | Native API / library            | `Bun.file().text()` instead of `cat` |
| 2     | Fixed command + parameterized args | `$`jq ${filter} ${file}`` with validated `filter` |
| 3     | Command allowlist               | Only `jq`, `grep`, `sort`, `wc` allowed |
| 4     | Full shell (AVOID)              | `bash -c ${command}`           |

If Level 4 is unavoidable, the tool **must**:

- Run in a restricted working directory (already done: `cwd(OUTPUT_DIR)`).
- Reject commands containing: `` ; | & > < ` $ ( ) { } ``  unless explicitly
  needed and individually validated.
- Cap output length (already done: `MAX_OUTPUT`).
- Set a timeout: `$`…`.timeout(30_000)`.

### 3.2 Network Access

- **Allowlisted hosts only.** Tools that make HTTP requests must validate the
  target URL against a list of allowed domains.
- Never let the LLM control the full URL. Construct it from a base URL +
  validated path segments.
- Always set a fetch timeout:

```typescript
const res = await fetch(url, {
  signal: AbortSignal.timeout(30_000),
});
```

### 3.3 File System Access

- All reads/writes go through `files` service (`src/services/file.ts`). Never
  use raw `fs`, `Bun.file()`, or `Bun.write()` in tool code.
- The file service enforces path allowlists — this is good, keep it.
- Tools must additionally validate filenames at their own layer (see 2.3).

### 3.4 Resource Limits

Every tool must protect against resource exhaustion:

| Resource       | Guard                                              |
| -------------- | -------------------------------------------------- |
| Output size    | Truncate to `MAX_OUTPUT` chars                     |
| File size      | Check size before reading: reject > 10 MB          |
| Batch size     | Cap array length (e.g., max 1000 rows)             |
| Request count  | Limit sequential requests in loops                 |
| Execution time | `AbortSignal.timeout()` on fetch, `.timeout()` on `$` |

---

## 4. Destructive Action Safeguards

Prompt injection is an **open, unsolved problem**. Assume the model *will* be
tricked into calling tools with malicious arguments. Layer defenses accordingly.

### 4.1 Classify Every Action

| Category       | Examples                     | Required safeguard              |
| -------------- | ---------------------------- | ------------------------------- |
| Read-only      | list, search, get status     | None beyond input validation    |
| Create         | write file, send request     | Validate output destination     |
| Mutate         | edit file, update record     | Checksum / version guard        |
| Destroy        | delete file, drop record     | Confirmation gate or disallow   |
| Irreversible   | send email, post to API      | Mandatory confirmation or scope lock |

### 4.2 Checksum / Version Guard

For mutating operations, require proof the caller has seen the current state:

```typescript
// Tool receives a checksum of the file the model read earlier.
// If the file changed since then, reject the edit.
if (currentChecksum !== payload.expected_checksum) {
  throw new Error("File changed since last read. Read it again before editing.");
}
```

This prevents blind overwrites and ensures the model's edits are based on
actual content.

### 4.3 Dry-Run Mode

For high-impact actions, support a `dryRun: true` flag that returns what
*would* happen without executing. The model can inspect the preview and
re-invoke with `dryRun: false`.

### 4.4 Undo / History

For lossy write operations (edit, delete), consider:

- Keeping a `.history/` of previous versions.
- Implementing a soft-delete (trash) instead of hard-delete.
- Limiting delete to single files / empty directories only.

### 4.5 Scope Locks

For irreversible external actions (sending email, posting to a 3rd-party API):

- Restrict recipients / targets to a programmatic allowlist.
- Never let the model control the destination freely.
- If an allowlist isn't feasible, require explicit user confirmation via the UI
  (buttons, not chat messages the model can fabricate).

---

## 5. Response Design

Tool responses are **the model's eyes**. A bad response degrades the entire
agent, even if the operation itself succeeded.

### 5.1 Structure

Every tool response should follow:

```typescript
{
  status: "ok" | "error",
  data: { /* minimal relevant payload */ },
  hints?: string[]   // actionable next-step suggestions for the model
}
```

### 5.2 Hints on Success

Don't just return data — tell the model what it can do next with the result.
**Describe the capability or goal, never reference another tool by name.**
The agent decides which tool to use; the tool just describes what is possible.

Format hints on a new line starting with `Note: …`:

- `"File saved to output/report.csv.\nNote: Verify contents or process further."`
- `"3 results found.\nNote: If none match, try broadening the search query."`
- `"Task created. The ID is T-42.\nNote: Use this ID for follow-up actions."`

This keeps tools decoupled — they stay reusable across different agent
configurations and toolsets.

### 5.3 Actionable Errors

Errors must answer three questions:

1. **What** happened? → `"Field 'status' has invalid value 'done'."`
2. **Why?** → `"Allowed values are: pending, in_progress, completed."`
3. **What now?** → `"Hint: did you mean 'completed'? Retry with corrected value."`

If the error relates to a missing prerequisite, describe what information is
needed — not which tool provides it:
`"team_id is required. Fetch the workspace metadata first."`

### 5.4 Minimal Payloads

- Return only fields the model needs for the next step.
- Omit internal IDs, hashes, timestamps, and metadata unless explicitly useful.
- For large results, write to a file and return the path — don't flood the
  context window.

### 5.5 File-Based Context Passing

When one tool produces data another tool consumes, **write to a file and pass
the path** instead of requiring the model to re-generate the content:

```
Tool A (generate_report) → writes report to output/report.md → returns { path }
Tool B (send_email)      → reads attachment from output/report.md
```

This halves token usage and eliminates re-generation errors.

### 5.6 Corrections

When a tool auto-corrects an input, tell the model:

- `"Requested lines 48-70, but file has 59 lines. Loaded range 48-59."`
- `"Query matched 2,847 results. Returning first 50. Use offset to paginate."`

---

## 6. Schema Rules

- One `.json` file per tool in `src/schemas/`, matched by filename.
- `additionalProperties: false` on every object.
- All properties listed in `required`.
- No `oneOf`, `anyOf`, type arrays — incompatible with OpenAI strict mode.
- Multi-action tools use top-level `actions` key (see `agents_hub` pattern).
- Descriptions must be concise and must NOT encourage dangerous usage patterns
  (no mentioning shell redirects, pipes, etc. in schema descriptions).
- Set sensible `default` values to minimize what the model must fill.

---

## 7. Prompt Injection Awareness

Prompt injection is an **open problem with no general solution**. Do not rely
on prompt-level defenses alone. Instead:

- **Design tools so damage is impossible**, not merely discouraged.
- **Never trust tool arguments** — validate as if they come from an attacker.
- **Limit blast radius** — a compromised tool call should affect only the
  current sandbox, not other users, external services, or persistent state.
- **Isolate external content** — data fetched from the web, emails, or
  user-uploaded files may contain injection payloads. Never pass such content
  as system-level instructions.
- **Log everything** — every tool call with arguments and results. If something
  goes wrong, the audit trail must be complete.
- **Accept that some actions cannot be given to agents** — if you can't make
  it safe by construction, don't build the tool.

---

## Checklist — Before Merging a New Tool

### Design
- [ ] Name is unique, unambiguous, `snake_case`
- [ ] Description has high signal-to-noise, no dangerous patterns
- [ ] Actions consolidated — agent stays under 15 tools total
- [ ] Model vs. code responsibilities clearly separated

### Input Validation
- [ ] Every string param has a length limit and char allowlist
- [ ] `JSON.parse()` is wrapped in `safeParse()`
- [ ] Filenames go through `safeFilename()`
- [ ] Object keys are checked against prototype-pollution blocklist
- [ ] Numeric params have min/max enforced in handler

### Sandboxing
- [ ] No raw `fs` / `Bun.file()` — uses `files` service
- [ ] Network requests have timeouts and hit allowlisted hosts only
- [ ] Output is truncated to `MAX_OUTPUT`
- [ ] File sizes are checked before reading
- [ ] Batch operations are capped and handle partial failure

### Destructive Actions
- [ ] Action classified (read / create / mutate / destroy / irreversible)
- [ ] Mutating actions use checksum or version guard
- [ ] Destructive actions gated by confirmation, dry-run, or scope lock
- [ ] Write operations support undo / history where feasible

### Responses
- [ ] Returns structured `{ status, data, hints }` shape
- [ ] Success responses include actionable hints
- [ ] Errors answer: what happened, why, what to do next
- [ ] Large outputs written to file, path returned
- [ ] Auto-corrections communicated to the model

### Security
- [ ] Error messages don't leak paths, keys, or stack traces
- [ ] External content (web, email, uploads) never injected as instructions
- [ ] All tool calls are logged with arguments and results
- [ ] Schema has `additionalProperties: false` and full `required` list
- [ ] Tests cover: valid input, malformed input, boundary values, injection attempts
