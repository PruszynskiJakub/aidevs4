# SP-74 Browser Tool

## Main objective

Add Playwright-based browser automation to the agent toolbox so it can interact with JS-rendered pages, fill forms, extract data via JavaScript evaluation, and take screenshots — with session persistence across runs.

## Context

The existing `web` tool (`src/tools/web.ts`) provides HTTP-level scraping via Serper and file downloads. It cannot execute JavaScript, interact with page elements, or handle authentication flows that require a real browser. Many AG3NTS hub tasks involve dynamic web pages, login-gated content, or multi-step form workflows that need a real browser.

The project already has:
- A multi-action tool pattern (`agents_hub.ts`, `web.ts`) that expands actions into separate LLM functions
- `ImagePart` type in `src/types/llm.ts` for returning base64 images
- `sessionService.outputPath()` for session-scoped file output
- `workspace/knowledge/` for persistent reference data
- Singleton infrastructure services with test overrides (`src/infra/file.ts`)

## Out of scope

- Multi-tab / multi-page browsing (single page per context)
- CAPTCHA solving or external anti-bot services
- Automated login flows (manual headful login → session persistence)
- Proxy configuration
- Browser extensions
- PDF generation from pages

## Constraints

- Must follow the multi-action tool pattern (no `oneOf`/`anyOf` in schemas)
- All file I/O through `files` service, never raw `fs`
- `playwright` package (not `playwright-core`) with Chromium only
- Timeouts on all browser operations (max 30s navigation, 5s element actions)
- DOM structure extraction capped at 1000 nodes / 8 depth to prevent huge files
- Page text artifact capped at 500 lines
- Expression input capped at 10,000 chars
- Screenshot file size capped at 1 MB (reject `full_page` if result exceeds this)
- Tool response hints must never reference other tools by name

## Acceptance criteria

- [ ] `browser__navigate` loads a URL, returns page title/URL, saves text + DOM structure artifacts to both session output and `workspace/browser/pages/`
- [ ] `browser__evaluate` executes JavaScript in page context and returns serialized result
- [ ] `browser__click` clicks elements by CSS selector or by visible text (separate parameters)
- [ ] `browser__type_text` fills input fields and optionally presses Enter
- [ ] `browser__take_screenshot` returns base64 PNG as `ImagePart` and saves file to session output
- [ ] Browser session (cookies, localStorage) persists to `workspace/browser/session.json` and restores on next launch
- [ ] Headful mode works when `BROWSER_HEADLESS=false` is set
- [ ] UserAgent is spoofed to a realistic Chrome string
- [ ] Navigate checks for instruction files at `workspace/knowledge/browser/{hostname}.md` and includes pointer in response
- [ ] `browser__navigate` detects error pages (HTTP errors, "access denied", 404 content) and flags `status: "error"` in response
- [ ] Feedback tracker records tool call outcomes and generates context-aware hints on failures
- [ ] After 2+ consecutive browser tool failures, response includes a hint to take a screenshot
- [ ] After recovery from failures, response includes a hint to save the working approach to a discovery file
- [ ] Response hints guide the agent toward next actions without naming tools
- [ ] System prompt additions teach the agent the browser workflow (instruction files → evaluate → struct search → save discoveries)
- [ ] Unit tests pass with mocked browser service
- [ ] Integration test launches headless Chromium and verifies navigate + evaluate + screenshot

## Implementation plan

### 1. Install dependency

Add `playwright` to `package.json`. Run `bunx playwright install chromium`.

### 2. Config additions (`src/config/env.ts`, `src/config/index.ts`)

**`env.ts`** — add optional:
```typescript
browserHeadless: process.env.BROWSER_HEADLESS !== "false",
```

**`index.ts`** — add `browser` section:
```typescript
browser: {
  headless: env.browserHeadless,
  sessionPath: join(WORKSPACE_DIR, "browser", "session.json"),
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  pagesDir: join(WORKSPACE_DIR, "browser", "pages"),
  timeouts: {
    navigation: 30_000,
    action: 5_000,
    evaluate: 30_000,
    screenshot: 10_000,
    settleAfterClick: 1_500,
    settleAfterType: 2_000,
    settleAfterNavigation: 2_000,
  },
  structMaxNodes: 1_000,
  structMaxDepth: 8,
  textMaxLines: 500,
  screenshotMaxBytes: 1_048_576,
},
```

Add `join(WORKSPACE_DIR, "browser")` to `sandbox.allowedWritePaths`.

### 3. Browser service (`src/infra/browser.ts`)

Singleton with lazy initialization:

```typescript
export interface BrowserService {
  getPage(): Promise<Page>;       // Launch browser on first call, return page
  saveSession(): Promise<void>;   // Persist storageState to session.json
  close(): Promise<void>;         // Save session + close browser (idempotent)
  isRunning(): boolean;
}

export let browser: BrowserService;
export function _setBrowserForTest(custom: BrowserService): () => void;
```

Key behaviors:
- On first `getPage()`: launch Chromium, create context with UA spoofing, load `session.json` if exists
- `saveSession()` called after every navigate. For click/type_text: snapshot `page.url()` before the action, compare after settle wait — if URL changed, call `saveSession()` and re-save page artifacts
- `getResponseStatus()`: return HTTP status from last navigation response (stored from `page.goto()` return value)
- Cleanup via `process.on('beforeExit')` and explicit `close()`
- Factory: `createBrowserService()` reads config for headless, sessionPath, userAgent

### 4. Browser tool (`src/tools/browser.ts`)

Multi-action tool with 5 actions:

**`navigate`** — `{ url: string }`
1. Validate URL (max 2048 chars, valid format)
2. `page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })`
3. Wait 2s for JS rendering
4. Extract `page.innerText('body')` → numbered lines (cap at 500 lines) → save as `{slug}.txt`
5. Extract DOM structure via `page.evaluate()` → save as `{slug}.struct.txt`
6. Save artifacts to session output AND `workspace/browser/pages/`
7. Save browser session
8. Detect error pages: check HTTP response status (4xx/5xx) and scan body text for patterns ("404", "not found", "access denied", "forbidden", "sorry"). Set `status: "error" | "ok"` in response
9. Check for instruction file at `workspace/knowledge/browser/{hostname}.md`
10. Return: title, URL, status, line count, resource refs to artifacts, instruction file pointer if found

**`evaluate`** — `{ expression: string }`
1. Validate expression (max 10,000 chars)
2. `page.evaluate(expression)` with 30s timeout
3. Serialize result (string as-is, object as JSON, undefined → "undefined")
4. If result > 5000 chars, truncate with note about full length

**`click`** — `{ css_selector?: string, text?: string }` (exactly one required)
1. Validate: exactly one of `css_selector` or `text` must be provided (max 500 chars)
2. If `text`: use `page.getByText(text).click({ timeout: 5_000 })`
3. If `css_selector`: use `page.click(css_selector, { timeout: 5_000 })`
4. Wait 1.5s for settling
5. Snapshot URL before click; if URL changed after, save session + re-save artifacts
6. Return current page title + URL

**`type_text`** — `{ selector: string, value: string, press_enter: boolean }`
1. Validate selector (max 500), value (max 5000)
2. Snapshot URL before action
3. `page.fill(selector, value, { timeout: 5_000 })`
4. If `press_enter`: `page.press(selector, "Enter")`
5. Wait 2s for settling
6. If URL changed after action, save session + re-save artifacts
7. Return current page title + URL

**`take_screenshot`** — `{ full_page: boolean }`
1. `page.screenshot({ fullPage, type: "png" })`
2. If buffer exceeds 1 MB, re-take as viewport-only and append a note that full-page was too large
3. Save PNG to session output
4. Return `ImagePart` (base64) + text with file path

### 5. Artifact formats

**`{slug}.txt`** — numbered text lines:
```
1: Welcome to Example
2: Navigation
3: Home | About | Contact
```

**`{slug}.struct.txt`** — recursive DOM tree:
```
body
  nav#main-nav
    ul.nav-list
      li > a[href="/home"] "Home"
  main.content
    h1 "Welcome"
    form#login-form
      input[name="email"][type="email"]
      button[type="submit"] "Sign In"
```

Per element: tag, `#id`, `.classes` (max 2), key attributes (`name`, `type`, `href`, `role`, `aria-label`, `data-testid`), leaf text (max 50 chars). Skip `<script>`, `<style>`, `<svg>` internals, `<noscript>`, hidden elements.

Slug: hostname + pathname, non-alphanumeric → `-`, max 80 chars. Append 6-char hash of full URL (including query params) to avoid collisions between pages that differ only in query string.

### 6. Instruction file pattern

- Directory: `workspace/knowledge/browser/`
- Per-site files: `{hostname}.md` (e.g. `hub.ag3nts.org.md`)
- Navigate action checks if file exists, includes pointer in response
- Agent uses `write_file` tool to create/update discoveries — browser tool only reads

### 7. Feedback tracker (`src/tools/browser-feedback.ts`)

Tracks browser tool call outcomes to generate context-aware hints and enable interventions.

```typescript
export interface BrowserFeedbackTracker {
  record(event: { tool: string; outcome: "success" | "fail"; args: Record<string, unknown>; error?: string }): void;
  consecutiveFailures(): number;
  lastVisitedHostname(): string | null;
  generateHints(tool: string, outcome: "success" | "fail", error?: string): string[];
  stats(): { total: number; successes: number; failures: number };
}
```

**Hint rules** (returned as strings, appended to tool response):
- JSON parse error → "Arguments must be valid JSON (no trailing commas, no markdown fences)"
- `click` timeout → "Element may not be visible — try scrolling or use a broader selector"
- `evaluate` null property → "A querySelector returned null — the expected element is missing"
- 3+ recent failures on same tool → "Multiple failures detected — consider a different strategy"

The tracker is instantiated per agent session (not per tool call) and passed to the tool executor. Hints are appended to the tool's text response — they never name other tools.

### 8. Interventions (`src/tools/browser-interventions.ts`)

Stateful logic that injects additional guidance into tool responses based on failure patterns.

**Screenshot intervention:**
- Triggers when `consecutiveFailures() >= 2`
- Fires once per session (flag: `screenshotHintSent`)
- Appends to response: "You've had {N} consecutive failures. The page may have changed — consider taking a screenshot to visually inspect the current state before trying another approach."

**Discovery intervention:**
- Triggers when a tool succeeds after previous failures (recovery detected)
- Fires once per session (flag: `discoveryHintSent`)
- Appends to response: "You recovered from earlier failures. Consider saving the working approach to workspace/knowledge/browser/{hostname}-discoveries.md so future runs can reuse it."

**End-of-task intervention:**
- If the agent's final response arrives and there were failures during the session but no discovery hint was sent, append a suggestion to save learnings.

Intervention state is held in-memory, reset per agent session.

### 9. System prompt additions

When the browser tool is registered, append the following to the agent's system prompt:

```
<browser_workflow>
You have access to a real browser for interacting with web pages.

Preferred workflow:
1. Before visiting a new site, check if an instruction file exists at workspace/knowledge/browser/{hostname}.md — read it for recipes and known patterns
2. Use evaluate to extract data via JavaScript — this is the fastest and cheapest approach, returning only what you query
3. If no recipe exists: navigate to the page, then search the saved .struct.txt file for CSS selectors, then write evaluate code using those selectors
4. When you discover a working approach (especially after trial and error), save it to workspace/knowledge/browser/{hostname}-discoveries.md with the actual JavaScript code, not just a description

Rules:
- ALWAYS prefer evaluate over reading full page text — it returns only what you extract
- Search .struct.txt files to discover selectors before writing evaluate code
- Never load full page text into conversation — use file reading with offset/limit for small sections
- For large outputs, write to files in smaller chunks (create + append) to avoid malformed arguments
- If a page requires login, tell the user to launch the browser in headful mode
- Be concise — return extracted data, not narration of what you did
</browser_workflow>
```

### 10. Register tool (`src/tools/index.ts`)

```typescript
import browser from "./browser.ts";
register(browser);
```

### 11. Tests

**`src/infra/browser.test.ts`** — unit tests:
- Mock Playwright page/context/browser
- Test `getPage()` lazy init, `saveSession()`, `close()` idempotency
- Test session file loading (exists vs missing vs corrupted)

**`src/tools/browser.test.ts`** — unit tests with mocked browser service:
- Each action: valid input happy path
- Input validation (URL too long, empty selector, oversized expression)
- Click: `css_selector` and `text` as separate params; error when both provided; error when neither provided
- Navigate: error page detection (4xx status, "access denied" body text)
- Navigate: text artifact truncated at 500 lines
- Instruction file loading on navigate
- Screenshot returns ImagePart; full-page fallback when over 1 MB

**`src/tools/browser-feedback.test.ts`** — unit tests:
- Hint generation for each error pattern (JSON parse, click timeout, evaluate null, repeated failures)
- `consecutiveFailures()` count resets on success
- `lastVisitedHostname()` returns correct domain after navigate

**`src/tools/browser-interventions.test.ts`** — unit tests:
- Screenshot hint fires at exactly 2 consecutive failures, not before
- Screenshot hint fires only once per session
- Discovery hint fires on recovery (success after failure), not on first success
- Discovery hint fires only once per session
- End-of-task hint appended when failures occurred but no discovery hint was sent

**`src/tools/browser.integration.test.ts`** — integration test:
- Launch headless Chromium against a local HTML string (`page.setContent()`)
- Navigate, evaluate JS, take screenshot
- Verify artifacts are written to expected paths
- Verify struct file respects depth/node caps

## Testing scenarios

| Criterion                     | Verification                                                                                       |
|-------------------------------|----------------------------------------------------------------------------------------------------|
| Navigate saves artifacts      | Check both session output and `workspace/browser/pages/` contain `.txt` and `.struct.txt`          |
| Navigate detects error pages  | Navigate to a 404 URL → response has `status: "error"`; navigate to valid page → `status: "ok"`    |
| Navigate caps text            | Page with 1000 lines of text → `.txt` artifact contains exactly 500 numbered lines                 |
| Evaluate returns results      | Run `document.title` and verify string returned                                                    |
| Click works by selector + text| Click via `css_selector` param, then via `text` param — verify page state changed                  |
| Click rejects ambiguous input | Providing both `css_selector` and `text` → validation error                                        |
| Click triggers artifact save  | Click a link that navigates → session saved, new page artifacts written                            |
| Type + Enter submits          | Fill a search box, press Enter, verify navigation + session saved                                  |
| Screenshot returns image      | Verify `ImagePart` with valid base64, file on disk                                                 |
| Screenshot size guard         | Full-page screenshot > 1 MB → falls back to viewport, response notes the fallback                  |
| Session persistence           | Navigate with login cookies → close → relaunch → verify cookies restored                           |
| Headful mode                  | Set `BROWSER_HEADLESS=false`, verify visible browser window opens                                  |
| Instruction files             | Create `workspace/knowledge/browser/example.com.md`, navigate to example.com, verify pointer       |
| Feedback hints                | Click missing selector → response includes "element may not be visible" hint                       |
| Screenshot intervention       | Two consecutive tool failures → response includes screenshot suggestion                            |
| Discovery intervention        | Tool success after failures → response includes save-discovery suggestion                          |
| Slug collision avoidance      | Navigate to `?q=foo` and `?q=bar` on same path → different artifact filenames                      |
