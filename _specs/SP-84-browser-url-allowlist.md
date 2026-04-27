# SP-84 Browser Navigation URL Allowlist

> Security fix: **C3** from security audit 2026-04-09.

## Main objective

Add URL validation to `browser__navigate` that blocks navigation to
localhost, internal IPs, `file://` URIs, and other SSRF-prone targets —
matching the allowlist pattern already used by the `web` tool.

## Context

`src/tools/browser.ts:175-186` navigates to any URL the LLM provides:

```typescript
const response = await page.goto(payload.url, {
  waitUntil: "domcontentloaded",
  timeout: config.browser.timeouts.navigation,
});
```

No hostname or protocol validation. The `web` tool (`src/tools/web.ts:15-22`)
already enforces a host allowlist via `config.sandbox.webAllowedHosts`:

```typescript
const hostname = parsed.hostname;
const allowed = config.sandbox.webAllowedHosts.some((entry) =>
  hostname.endsWith(entry),
);
if (!allowed) throw new Error(`Host "${hostname}" is not on the allowlist`);
```

The browser tool has no equivalent check. This enables:

- **SSRF**: LLM navigates to `http://127.0.0.1:8080/admin` or
  `http://169.254.169.254/latest/meta-data/` (cloud metadata endpoint).
- **Local file access**: `file:///etc/passwd`, `file:///Users/.../.env`.
- **Attacker-controlled pages**: LLM navigates to a page hosting malicious
  JS that exfiltrates cookies, localStorage, or executes `page.evaluate()`
  payloads.

The browser and web tools have **different trust models** — the web tool is
a simple fetcher with no JS execution, while the browser runs a full
Chromium instance. The browser needs **stricter** controls, not looser.

## Out of scope

- Restricting `page.evaluate()` expressions (separate concern, separate spec).
- Changing the web tool's allowlist.
- Adding per-domain cookie/storage isolation.
- Content Security Policy injection.

## Constraints

- No new runtime dependencies.
- Must not break existing browser tool tests.
- The allowlist must be configurable (not hardcoded) via `config`.
- Default-open for general web (block dangerous targets), not default-closed
  (would break the tool's primary use case of navigating arbitrary sites).

## Design decision: blocklist vs allowlist

The web tool uses an **allowlist** (only `.ag3nts.org` by default) because
it's a narrow-purpose fetcher. The browser tool is general-purpose — it
needs to navigate arbitrary sites for scraping, form-filling, and
interaction. A strict allowlist would cripple it.

**Approach**: Use a **blocklist** for dangerous targets (SSRF, local files)
combined with a **protocol allowlist** (`http:`, `https:` only).

## Changes

### 1. Add browser blocklist config — `src/config/index.ts`

Add to the `browser` section:

```typescript
browser: {
  // ... existing fields ...
  blockedHostPatterns: [
    "localhost",
    "127.0.0.1",
    "[::1]",
    "0.0.0.0",
    "169.254.169.254",       // AWS metadata
    "metadata.google.internal", // GCP metadata
  ] as readonly string[],
  allowedProtocols: ["http:", "https:"] as readonly string[],
}
```

### 2. Add URL validation function — `src/tools/browser.ts`

Add before the `navigate` function:

```typescript
function assertNavigationAllowed(url: string): void {
  const parsed = new URL(url); // already called in navigate, reuse

  // Protocol check
  if (!config.browser.allowedProtocols.includes(parsed.protocol)) {
    throw new Error(
      `Navigation blocked: protocol "${parsed.protocol}" is not allowed. ` +
      `Only ${config.browser.allowedProtocols.join(", ")} are permitted.`
    );
  }

  // Hostname blocklist
  const hostname = parsed.hostname;
  const blocked = config.browser.blockedHostPatterns.some((pattern) =>
    hostname === pattern || hostname.endsWith(`.${pattern}`)
  );
  if (blocked) {
    throw new Error(
      `Navigation blocked: "${hostname}" is a restricted host. ` +
      `Cannot navigate to localhost, internal IPs, or cloud metadata endpoints.`
    );
  }

  // Private IP range check (covers 10.x, 172.16-31.x, 192.168.x)
  if (isPrivateIP(hostname)) {
    throw new Error(
      `Navigation blocked: "${hostname}" resolves to a private IP range.`
    );
  }
}

function isPrivateIP(hostname: string): boolean {
  // Match common private IPv4 patterns
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((p) => isNaN(Number(p)))) return false;

  const [a, b] = parts.map(Number);
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 0) return true;                            // 0.0.0.0/8
  return false;
}
```

### 3. Wire validation into navigate — `src/tools/browser.ts`

**Current** `navigate()` (line 175-186):
```typescript
async function navigate(payload: { url: string }): Promise<ToolResult> {
  assertMaxLength(payload.url, "url", 2048);
  const parsed = new URL(payload.url);
  const session = getSession();
  const page = await session.getPage();
  const response = await page.goto(payload.url, { ... });
```

**Target**:
```typescript
async function navigate(payload: { url: string }): Promise<ToolResult> {
  assertMaxLength(payload.url, "url", 2048);
  assertNavigationAllowed(payload.url);
  const parsed = new URL(payload.url);
  // ... rest unchanged
```

### 4. Update tool description — `src/tools/browser.ts`

Update the `navigate` action description to mention the restriction:

> Cannot navigate to localhost, private IPs, cloud metadata endpoints, or
> non-HTTP protocols.

## Test plan

1. **Blocked targets**: Verify `navigate` throws for:
   - `http://localhost:3000`
   - `http://127.0.0.1:8080/admin`
   - `http://169.254.169.254/latest/meta-data/`
   - `file:///etc/passwd`
   - `http://10.0.0.1/internal`
   - `http://192.168.1.1/admin`
   - `ftp://example.com/file`
2. **Allowed targets**: Verify `navigate` works for:
   - `https://example.com`
   - `https://hub.ag3nts.org/task`
   - `https://8.8.8.8` (public IP)
3. **Existing tests**: `bun test src/tools/browser` passes.
4. **Edge cases**: `http://localhost.evil.com` must NOT be blocked (it's not
   actually localhost). `http://[::1]:8080` must be blocked.
