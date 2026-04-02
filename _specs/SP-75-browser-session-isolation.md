# SP-75 Browser Session Isolation

## Main objective

Rework the browser infrastructure so each agent session gets its own Chromium process, enabling parallel task execution while sharing cookies and discovery files across sessions.

## Context

SP-74 delivered a working browser tool, but it uses a module-level singleton — one Browser, one Page, one feedback tracker. This means:
- Two parallel agent sessions fight over the same page
- Cookie saves from one session overwrite another's
- Page artifacts collide on identical URLs
- Feedback tracker state leaks across sessions

The tool works fine for sequential single-task usage (confirmed in sessions `2509133c` and `3061d6e0`), but the architecture blocks concurrent execution.

Additionally, navigate currently dual-writes page artifacts to both `workspace/browser/pages/` and session output — but only the `pages/` copies are referenced in tool responses. The session output copies are dead writes.

## Out of scope

- BrowserContext-level isolation (sharing one Chromium process) — we want full process isolation
- Real-time cookie sync between running sessions
- Shared feedback/intervention state across sessions
- Multi-tab support within a session

## Constraints

- Must not break the existing 5-action tool API (navigate, evaluate, click, type_text, take_screenshot)
- Cookie file remains at `workspace/browser/session.json` (single shared file, snapshot-on-start, last-write-wins with atomic writes)
- Discovery files remain at `workspace/knowledge/browser/` (filesystem-level sharing, no coordination needed)
- Feedback tracker and interventions remain per-session (failure patterns are context-specific)
- Page artifacts written only to `workspace/browser/pages/` (drop session output copies)
- Maximum 3 concurrent Chromium processes (configurable via `config.browser.maxPoolSize`)

## Acceptance criteria

- [ ] Each agent session gets its own Chromium process via `browserPool.get()` (resolves session from `AsyncLocalStorage` context)
- [ ] Two agent sessions can run browser tools concurrently without interfering
- [ ] Each session loads `session.json` as a snapshot on first `getPage()` call
- [ ] Each session writes back to `session.json` on close/navigate (atomic write: temp file + rename)
- [ ] Feedback tracker and interventions are owned by `BrowserSession`, not scattered in the tool module
- [ ] `browserPool.closeAll()` shuts down all browser processes on SIGINT/SIGTERM/uncaughtException
- [ ] Pool enforces `maxPoolSize` — throws if limit reached
- [ ] Idle browsers are closed after `idleTimeout` (default 5 minutes)
- [ ] Session output artifact copies are removed — only `workspace/browser/pages/` writes remain
- [ ] Existing tool behavior (responses, artifact format, instruction file detection) is unchanged
- [ ] Unit tests verify pool lifecycle (create, get, close, closeAll, max size, idle timeout)
- [ ] Integration test runs two sessions concurrently navigating different URLs

## Implementation plan

### 1. Config additions (`src/config/index.ts`)

Add to `browser` section:
```typescript
maxPoolSize: 3,
idleTimeout: 5 * 60_000,  // 5 minutes
```

### 2. Browser session bundle (`src/infra/browser.ts`)

Replace the module-level singleton with a pool that returns a `BrowserSession` — a bundle of browser + feedback + interventions with unified lifecycle:

```typescript
export interface BrowserSession {
  getPage(): Promise<Page>;
  saveSession(): Promise<void>;
  close(): Promise<void>;
  isRunning(): boolean;
  readonly feedbackTracker: BrowserFeedbackTracker;
  readonly interventions: BrowserInterventions;
}

export interface BrowserPool {
  /** Get or create a session's browser. Resolves sessionId from AsyncLocalStorage context. */
  get(): BrowserSession;
  /** Close a specific session's browser + feedback state. */
  close(sessionId: string): Promise<void>;
  /** Close all browsers (shutdown hook). */
  closeAll(): Promise<void>;
}
```

Key design decisions:
- **Session resolution**: `get()` calls `requireSessionId()` from `src/agent/context.ts` internally — the tool layer never handles session IDs
- **Unified ownership**: Each `BrowserSession` owns its browser, feedbackTracker, and interventions. `pool.close(sessionId)` cleans up everything in one place
- **Pool size limit**: `get()` throws if `Map.size >= config.browser.maxPoolSize`
- **Idle timeout**: Each `BrowserSession` tracks `lastActivity` timestamp, updated on every `getPage()` call. A `setInterval` in the pool checks for idle sessions and closes them
- **Crash recovery**: `getPage()` checks `pageInstance.isClosed()` — if the browser died, it re-launches transparently
- **Atomic cookie writes**: `saveSession()` writes to a temp file, then `rename()` to `session.json` (atomic on POSIX). Avoids corrupted reads from concurrent sessions
- **`mkdir` once**: Pool creates `workspace/browser/` and `workspace/browser/pages/` once at construction, not on every operation

Internal: `Map<string, BrowserSession>` keyed by sessionId. `createBrowserSession()` factory creates a fully-equipped session (browser + tracker + interventions).

Process cleanup:
```typescript
process.once("SIGINT", () => browserPool.closeAll());
process.once("SIGTERM", () => browserPool.closeAll());
process.once("uncaughtException", () => browserPool.closeAll());
```

Note: uses `process.once()` to avoid handler accumulation on hot-reload/test re-imports.

### 3. Wire tool to pool (`src/tools/browser.ts`)

Replace:
```typescript
import { browser } from "../infra/browser.ts";
const feedbackTracker = createBrowserFeedbackTracker();
const interventions = createBrowserInterventions(feedbackTracker);
```

With:
```typescript
import { browserPool } from "../infra/browser.ts";
```

Every action function calls `browserPool.get()` to obtain the `BrowserSession`. Feedback and interventions are accessed via `session.feedbackTracker` and `session.interventions`. No Maps in the tool module — all per-session state lives in the pool.

Update all ~8 call sites in action functions (`navigate`, `evaluate`, `click`, `typeText`, `takeScreenshot`, `handlePostAction`, `appendFeedback`).

### 4. Drop session output artifact copies (`src/tools/browser.ts`)

In `savePageArtifacts()`, remove the `sessionService.outputPath()` calls. Only write to `config.browser.pagesDir`. Run `mkdir` and `extractDomStructure` in parallel:

```typescript
async function savePageArtifacts(page, urlStr, bodyText) {
  const slug = urlSlug(urlStr);
  const numbered = extractNumberedText(bodyText, config.browser.textMaxLines);

  const pagesDir = config.browser.pagesDir;
  const [struct] = await Promise.all([
    extractDomStructure(page),
    files.mkdir(pagesDir),  // no-op after first call, but cheap
  ]);

  const textPath = join(pagesDir, `${slug}.txt`);
  const structPath = join(pagesDir, `${slug}.struct.txt`);

  await Promise.all([
    files.write(textPath, numbered),
    files.write(structPath, struct),
  ]);

  return { textPath, structPath, lineCount: numbered.split("\n").length };
}
```

### 5. Screenshot output

Screenshots still go to session output (via `sessionService.outputPath()`) since they're ephemeral per-run artifacts, not reusable cross-session like page text/struct.

### 6. Tests

**`src/infra/browser.test.ts`** — update:
- Test pool `get()` returns same instance for same sessionId (via mocked context)
- Test pool `get()` returns different instances for different sessionIds
- Test `close(sessionId)` cleans up browser + feedback + interventions
- Test `closeAll()` closes all
- Test `get()` after `close()` creates a new instance
- Test `get()` throws when pool is at max capacity
- Test idle timeout closes unused sessions
- Test crash recovery: mock a closed page, verify `getPage()` re-launches

**`src/tools/browser.test.ts`** — update:
- Mock `browserPool` instead of `browser`
- Verify `savePageArtifacts` no longer writes to session output
- Verify feedback tracker comes from `BrowserSession`, not a module-level Map
- Update `_setBrowserForTest` → `_setBrowserPoolForTest` in all test files

**`src/tools/browser.integration.test.ts`** — add:
- Two concurrent sessions navigate different URLs (use `runWithContext` to set different session IDs)
- Verify each gets correct page content
- Verify `workspace/browser/pages/` has artifacts for both URLs
- Verify no session output copies exist

## Testing scenarios

| Criterion | Verification |
|-----------|-------------|
| Session isolation | Two sessions navigate different URLs concurrently — each gets correct title/content |
| Cookie snapshot | Session A logs in, saves. Session B starts, has A's cookies (atomic read). B saves. Session C has B's cookies |
| Cookie atomicity | Kill a session mid-save → `session.json` is either old or new, never corrupted |
| No session output copies | After navigate, `workspace/sessions/.../output/` has no .txt/.struct.txt (only screenshots) |
| Feedback per session | Session A has 3 failures → screenshot hint. Session B clean → no hint. Feedback state lives on `BrowserSession` |
| Pool max size | Launch 3 sessions → OK. 4th `get()` → throws error with clear message |
| Idle timeout | Session unused for 5 min → Chromium process closed, Map entry removed |
| Crash recovery | Kill Chromium process → next `getPage()` re-launches transparently |
| Pool cleanup | SIGTERM → all browser processes terminated, all session.json writes complete |
| Pool re-creation | Close session A's browser, call `get()` again in same context → new Chromium process |
