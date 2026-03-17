# SP-28: Centralized Config Module Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace flat `src/config.ts` with a validated, singleton, deeply-frozen config module at `src/config/index.ts`.

**Architecture:** A single `src/config/index.ts` reads all env vars, validates required ones (fail-fast), computes derived values, builds a typed `Config` object, deep-freezes it, and exports it as a named `config` export. All 15 source files and 7 test files that import from `config.ts` are updated to use `config.<group>.<key>`. Scattered `process.env` reads in 4 other files are replaced with config references.

**Tech Stack:** Bun, TypeScript (strict), zero new dependencies. Hand-written validation.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/config/index.ts` | Config type, env validation, deep-freeze, singleton export |
| Create | `src/config/index.test.ts` | Tests: required var missing, optional defaults, freeze, keys present |
| Delete | `src/config.ts` | Old flat constants file (replaced) |
| Modify | `src/services/file.ts` | Import from `../config` → `./index`, export mutable path arrays for test injection |
| Modify | `src/services/markdown-logger.ts` | `LOGS_DIR` → `config.paths.logsDir` |
| Modify | `src/services/llm.ts` | `process.env.GEMINI_API_KEY` → `config.keys.geminiApiKey` |
| Modify | `src/services/prompt.test.ts` | Import update + use mutable paths from file service |
| — | `src/services/markdown-logger.test.ts` | No changes needed (already uses DI, no config import) |
| Modify | `src/providers/gemini.ts` | `GEMINI_TIMEOUT` → `config.limits.geminiTimeout` |
| Modify | `src/utils/hub.ts` | `process.env.HUB_API_KEY` → `config.hub.apiKey` |
| Modify | `src/utils/parse.ts` | `MAX_FILE_SIZE` → `config.limits.maxFileSize` |
| Modify | `src/utils/output.ts` | `OUTPUT_DIR` → `config.paths.outputDir` |
| Modify | `src/agent.ts` | `MAX_ITERATIONS` + `process.env.PERSONA` → config refs |
| Modify | `src/server.ts` | `process.env.PERSONA` + `process.env.PORT` → config refs |
| Modify | `src/tools/bash.ts` | `OUTPUT_DIR` → `config.paths.outputDir` |
| Modify | `src/tools/web.ts` | `FETCH_TIMEOUT`, `WEB_ALLOWED_HOSTS`, `WEB_PLACEHOLDER_MAP` → config refs |
| Modify | `src/tools/shipping.ts` | `HUB_BASE_URL`, `FETCH_TIMEOUT` → config refs |
| Modify | `src/tools/agents_hub.ts` | Multiple config constants → config refs |
| Modify | `src/tools/document_processor.ts` | `GEMINI_MODEL`, `DOC_MAX_FILES`, `MAX_FILE_SIZE` → config refs |
| Modify | `src/tools/geo_distance.ts` | `MAX_FILE_SIZE` → config refs |
| Modify | `src/tools/bash.test.ts` | `OUTPUT_DIR` → `config.paths.outputDir` |
| Modify | `src/tools/web.test.ts` | Mutable test paths + `apikey` assertion → `config.hub.apiKey` |
| Modify | `src/tools/shipping.test.ts` | `apikey` assertions from `"test-key-123"` → `config.hub.apiKey` |
| Modify | `src/tools/agents_hub.test.ts` | Mutable test paths + `apikey` assertions → `config.hub.apiKey` |
| Modify | `src/tools/geo_distance.test.ts` | Mutable test paths from file service |

---

## Config Shape

```ts
interface Config {
  paths: {
    projectRoot: string;
    outputDir: string;
    logsDir: string;
  };
  sandbox: {
    allowedReadPaths: readonly string[];
    allowedWritePaths: readonly string[];
    webAllowedHosts: readonly string[];
  };
  models: {
    agent: string;
    transform: string;
    gemini: string;
  };
  hub: {
    baseUrl: string;
    verifyUrl: string;
    apiKey: string;
  };
  keys: {
    openaiApiKey: string;
    geminiApiKey: string | undefined;
  };
  limits: {
    maxIterations: number;
    fetchTimeout: number;
    maxBatchRows: number;
    maxFileSize: number;
    transformBatchSize: number;
    geminiTimeout: number;
    docMaxFiles: number;
  };
  web: {
    placeholderMap: Readonly<Record<string, () => string>>;
  };
  server: {
    port: number;
  };
  persona: string | undefined;
}
```

## Test Array Mutation Strategy

Several test files currently push tmp dirs into `ALLOWED_READ_PATHS` / `ALLOWED_WRITE_PATHS` arrays exported from `config.ts`. With frozen config, this breaks. Resolution:

- `file.ts` will store its own **mutable** path arrays (spread from frozen config at init)
- `file.ts` exports these as `_testReadPaths` and `_testWritePaths` (underscore prefix signals test-only)
- Tests push/splice on these exported arrays instead of config arrays
- The default `files` singleton uses these mutable arrays internally
- **Test assertions remain unchanged** — only the import source and variable name for path mutation changes

---

## Task 1: Create `src/config/index.ts` with validation and deep-freeze

**Files:**
- Create: `src/config/index.ts`

- [ ] **Step 1: Write the config module**

```ts
import { join, resolve } from "path";

// src/config/index.ts lives in src/config/ — project root is two levels up
const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const OUTPUT_DIR = join(PROJECT_ROOT, "src/output");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

// Validate all required env vars upfront — collect all missing, don't fail on first
const REQUIRED_VARS = ["HUB_API_KEY", "OPENAI_API_KEY"] as const;
const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(", ")}`,
  );
}

const HUB_BASE_URL = "https://hub.ag3nts.org";

export const config = deepFreeze({
  paths: {
    projectRoot: PROJECT_ROOT,
    outputDir: OUTPUT_DIR,
    logsDir: LOGS_DIR,
  },
  sandbox: {
    allowedReadPaths: [PROJECT_ROOT] as readonly string[],
    allowedWritePaths: [OUTPUT_DIR, LOGS_DIR] as readonly string[],
    webAllowedHosts: [".ag3nts.org"] as readonly string[],
  },
  models: {
    agent: "gpt-4.1",
    transform: "gpt-4.1-mini",
    gemini: "gemini-2.5-flash",
  },
  hub: {
    baseUrl: HUB_BASE_URL,
    verifyUrl: `${HUB_BASE_URL}/verify`,
    apiKey: requireEnv("HUB_API_KEY"),
  },
  keys: {
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    geminiApiKey: process.env.GEMINI_API_KEY as string | undefined,
  },
  limits: {
    maxIterations: 20,
    fetchTimeout: 30_000,
    maxBatchRows: 1000,
    maxFileSize: 10 * 1024 * 1024,
    transformBatchSize: 25,
    geminiTimeout: 60_000,
    docMaxFiles: 10,
  },
  web: {
    placeholderMap: {
      hub_api_key: () => config.hub.apiKey,
    } as Record<string, () => string>,
  },
  server: {
    port: Number(process.env.PORT) || 3000,
  },
  persona: process.env.PERSONA as string | undefined,
});

export default config;
```

Note: `web.placeholderMap.hub_api_key` references `config.hub.apiKey` (self-referencing through the closure). This works because the closure captures `config` by reference and the lambda is called lazily, not at construction time.

- [ ] **Step 2: Verify the module loads without error**

Run: `bun run src/config/index.ts`
Expected: exits cleanly (no output, no error — assuming `.env` has required vars)

- [ ] **Step 3: Commit**

```bash
git add src/config/index.ts
git commit -m "feat(config): add centralized config module with validation and deep-freeze (SP-28)"
```

---

## Task 2: Write config module tests

**Files:**
- Create: `src/config/index.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { config } from "./index.ts";

// For subprocess tests — avoids depending on config for cwd
const PROJECT_ROOT = resolve(import.meta.dir, "../..");

describe("config module", () => {
  it("exports config with all expected top-level groups", () => {
    expect(config.paths).toBeDefined();
    expect(config.sandbox).toBeDefined();
    expect(config.models).toBeDefined();
    expect(config.hub).toBeDefined();
    expect(config.keys).toBeDefined();
    expect(config.limits).toBeDefined();
    expect(config.web).toBeDefined();
    expect(config.server).toBeDefined();
  });

  it("has correct static values", () => {
    expect(config.models.agent).toBe("gpt-4.1");
    expect(config.models.transform).toBe("gpt-4.1-mini");
    expect(config.models.gemini).toBe("gemini-2.5-flash");
    expect(config.limits.maxIterations).toBe(20);
    expect(config.limits.fetchTimeout).toBe(30_000);
    expect(config.limits.maxBatchRows).toBe(1000);
    expect(config.limits.maxFileSize).toBe(10 * 1024 * 1024);
    expect(config.limits.transformBatchSize).toBe(25);
    expect(config.limits.geminiTimeout).toBe(60_000);
    expect(config.limits.docMaxFiles).toBe(10);
    expect(config.hub.baseUrl).toBe("https://hub.ag3nts.org");
    expect(config.hub.verifyUrl).toBe("https://hub.ag3nts.org/verify");
    expect(config.sandbox.webAllowedHosts).toEqual([".ag3nts.org"]);
  });

  it("resolves projectRoot to the repo root", () => {
    const expected = resolve(import.meta.dir, "../..");
    expect(config.paths.projectRoot).toBe(expected);
  });

  it("reads HUB_API_KEY from env", () => {
    expect(typeof config.hub.apiKey).toBe("string");
    expect(config.hub.apiKey.length).toBeGreaterThan(0);
  });

  it("server.port is a valid number", () => {
    expect(typeof config.server.port).toBe("number");
    expect(config.server.port).toBeGreaterThanOrEqual(1);
  });

  it("geminiApiKey is string or undefined", () => {
    expect(
      config.keys.geminiApiKey === undefined ||
      typeof config.keys.geminiApiKey === "string",
    ).toBe(true);
  });

  it("throws TypeError when mutating a top-level property", () => {
    expect(() => {
      (config as any).persona = "hacked";
    }).toThrow();
  });

  it("throws TypeError when mutating a nested property", () => {
    expect(() => {
      (config.limits as any).maxIterations = 99;
    }).toThrow();
  });

  it("throws TypeError when pushing to a frozen array", () => {
    expect(() => {
      (config.sandbox.allowedReadPaths as string[]).push("/tmp");
    }).toThrow();
  });
});

describe("config validation (subprocess)", () => {
  it("throws when HUB_API_KEY is missing", async () => {
    const proc = Bun.spawn(
      ["bun", "-e", "await import('./src/config/index.ts')"],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, HUB_API_KEY: "" },
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Missing required environment variable");
    expect(stderr).toContain("HUB_API_KEY");
  });

  it("throws when OPENAI_API_KEY is missing", async () => {
    const proc = Bun.spawn(
      ["bun", "-e", "await import('./src/config/index.ts')"],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, OPENAI_API_KEY: "" },
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Missing required environment variable");
    expect(stderr).toContain("OPENAI_API_KEY");
  });

  it("lists all missing vars when multiple are absent", async () => {
    const proc = Bun.spawn(
      ["bun", "-e", "await import('./src/config/index.ts')"],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, HUB_API_KEY: "", OPENAI_API_KEY: "" },
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("HUB_API_KEY");
    expect(stderr).toContain("OPENAI_API_KEY");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test src/config/index.test.ts`
Expected: all tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/config/index.test.ts
git commit -m "test(config): add config module tests for validation, defaults, and freeze (SP-28)"
```

---

## Task 3: Update `src/services/file.ts` — mutable path arrays for test injection

**Files:**
- Modify: `src/services/file.ts`

- [ ] **Step 1: Update file.ts to use config module and export mutable test paths**

Change imports and default arguments:

```ts
// OLD:
import { ALLOWED_READ_PATHS, ALLOWED_WRITE_PATHS } from "../config.ts";

// NEW:
import { config } from "../config/index.ts";
```

Add mutable path arrays (for test injection) and update the default `files` singleton:

```ts
// Mutable copies of config paths — tests push/splice these for temp dir access
export const _testReadPaths: string[] = [...config.sandbox.allowedReadPaths];
export const _testWritePaths: string[] = [...config.sandbox.allowedWritePaths];

export function createBunFileService(
  readPaths: string[] = _testReadPaths,
  writePaths: string[] = _testWritePaths,
): FileProvider {
  // ... same implementation, no changes to assertPathAllowed or methods
}

export const files: FileProvider = createBunFileService();
```

- [ ] **Step 2: Run existing file-dependent tests**

Run: `bun test src/services/markdown-logger.test.ts`
Expected: PASS (this test already uses DI for file service and logsDir)

- [ ] **Step 3: Commit**

```bash
git add src/services/file.ts
git commit -m "refactor(file): use config module, export mutable test paths (SP-28)"
```

---

## Task 4: Update `src/utils/` files

**Files:**
- Modify: `src/utils/hub.ts`
- Modify: `src/utils/parse.ts`
- Modify: `src/utils/output.ts`

- [ ] **Step 1: Update `hub.ts`**

```ts
// OLD:
export function getApiKey(): string {
  const apiKey = process.env.HUB_API_KEY;
  if (!apiKey) throw new Error("HUB_API_KEY environment variable is not set");
  return apiKey;
}

// NEW:
import { config } from "../config/index.ts";

export function getApiKey(): string {
  return config.hub.apiKey;
}
```

- [ ] **Step 2: Update `parse.ts`**

```ts
// OLD:
import { MAX_FILE_SIZE } from "../config.ts";

// NEW:
import { config } from "../config/index.ts";
```

And change the default parameter:
```ts
// OLD:
export async function checkFileSize(path: string, maxBytes: number = MAX_FILE_SIZE): Promise<void> {
// NEW:
export async function checkFileSize(path: string, maxBytes: number = config.limits.maxFileSize): Promise<void> {
```

- [ ] **Step 3: Update `output.ts`**

```ts
// OLD:
import { OUTPUT_DIR } from "../config.ts";

// NEW:
import { config } from "../config/index.ts";
```

And update references:
```ts
export async function ensureOutputDir(): Promise<void> {
  await files.mkdir(config.paths.outputDir);
}

export function outputPath(filename: string): string {
  return join(config.paths.outputDir, filename);
}
```

- [ ] **Step 4: Verify**

Run: `bun test src/`
Expected: existing tests still pass

- [ ] **Step 5: Commit**

```bash
git add src/utils/hub.ts src/utils/parse.ts src/utils/output.ts
git commit -m "refactor(utils): use config module instead of flat constants and process.env (SP-28)"
```

---

## Task 5: Update `src/services/markdown-logger.ts` and `src/services/llm.ts`

**Files:**
- Modify: `src/services/markdown-logger.ts`
- Modify: `src/services/llm.ts`

- [ ] **Step 1: Update `markdown-logger.ts`**

```ts
// OLD:
import { LOGS_DIR } from "../config.ts";

// NEW:
import { config } from "../config/index.ts";
```

And update the constructor default:
```ts
// OLD:
const logsDir = options?.logsDir ?? LOGS_DIR;

// NEW:
const logsDir = options?.logsDir ?? config.paths.logsDir;
```

- [ ] **Step 2: Update `llm.ts`**

```ts
// OLD:
const geminiKey = process.env.GEMINI_API_KEY;

// NEW:
import { config } from "../config/index.ts";
const geminiKey = config.keys.geminiApiKey;
```

- [ ] **Step 3: Verify**

Run: `bun test src/services/markdown-logger.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/markdown-logger.ts src/services/llm.ts
git commit -m "refactor(services): use config module for logs dir and gemini key (SP-28)"
```

---

## Task 6: Update `src/providers/gemini.ts`

**Files:**
- Modify: `src/providers/gemini.ts`

- [ ] **Step 1: Update gemini provider**

```ts
// OLD:
import { GEMINI_TIMEOUT } from "../config.ts";

// NEW:
import { config } from "../config/index.ts";
```

Replace all `GEMINI_TIMEOUT` usages with `config.limits.geminiTimeout` (2 occurrences in `chatCompletion` and `completion`).

- [ ] **Step 2: Commit**

```bash
git add src/providers/gemini.ts
git commit -m "refactor(gemini): use config module for timeout (SP-28)"
```

---

## Task 7: Update `src/agent.ts` and `src/server.ts`

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Update `agent.ts`**

```ts
// OLD:
import { MAX_ITERATIONS } from "./config.ts";
// ... later:
const persona = getPersona(process.env.PERSONA);

// NEW:
import { config } from "./config/index.ts";
// ... later:
const persona = getPersona(config.persona);
```

Replace `MAX_ITERATIONS` with `config.limits.maxIterations` (2 occurrences: loop condition and `maxIter` call).

- [ ] **Step 2: Update `server.ts`**

```ts
// OLD:
const persona = getPersona(process.env.PERSONA);
const port = Number(process.env.PORT) || 3000;

// NEW:
import { config } from "./config/index.ts";
const persona = getPersona(config.persona);
const port = config.server.port;
```

Remove `process.env.PERSONA` and `process.env.PORT` references.

- [ ] **Step 3: Commit**

```bash
git add src/agent.ts src/server.ts
git commit -m "refactor(agent,server): use config module for iterations, persona, port (SP-28)"
```

---

## Task 8: Update tool source files

**Files:**
- Modify: `src/tools/bash.ts`
- Modify: `src/tools/web.ts`
- Modify: `src/tools/shipping.ts`
- Modify: `src/tools/agents_hub.ts`
- Modify: `src/tools/document_processor.ts`
- Modify: `src/tools/geo_distance.ts`

- [ ] **Step 1: Update `bash.ts`**

```ts
// OLD:
import { OUTPUT_DIR } from "../config.ts";
const cwd = resolve(OUTPUT_DIR);

// NEW:
import { config } from "../config/index.ts";
const cwd = resolve(config.paths.outputDir);
```

- [ ] **Step 2: Update `web.ts`**

```ts
// OLD:
import { FETCH_TIMEOUT, WEB_ALLOWED_HOSTS, WEB_PLACEHOLDER_MAP } from "../config.ts";

// NEW:
import { config } from "../config/index.ts";
```

Replace references:
- `WEB_PLACEHOLDER_MAP` → `config.web.placeholderMap`
- `WEB_ALLOWED_HOSTS` → `config.sandbox.webAllowedHosts`
- `FETCH_TIMEOUT` → `config.limits.fetchTimeout`

- [ ] **Step 3: Update `shipping.ts`**

```ts
// OLD:
import { HUB_BASE_URL, FETCH_TIMEOUT } from "../config.ts";
const PACKAGES_URL = `${HUB_BASE_URL}/api/packages`;

// NEW:
import { config } from "../config/index.ts";
const PACKAGES_URL = `${config.hub.baseUrl}/api/packages`;
```

Replace `FETCH_TIMEOUT` → `config.limits.fetchTimeout` (2 occurrences).

- [ ] **Step 4: Update `agents_hub.ts`**

```ts
// OLD:
import { HUB_BASE_URL, HUB_VERIFY_URL, FETCH_TIMEOUT, MAX_BATCH_ROWS, MAX_FILE_SIZE } from "../config.ts";

// NEW:
import { config } from "../config/index.ts";
```

Replace references:
- `HUB_VERIFY_URL` → `config.hub.verifyUrl`
- `HUB_BASE_URL` → `config.hub.baseUrl`
- `FETCH_TIMEOUT` → `config.limits.fetchTimeout`
- `MAX_BATCH_ROWS` → `config.limits.maxBatchRows`
- `MAX_FILE_SIZE` → `config.limits.maxFileSize`

- [ ] **Step 5: Update `document_processor.ts`**

```ts
// OLD:
import { GEMINI_MODEL, DOC_MAX_FILES, MAX_FILE_SIZE } from "../config.ts";

// NEW:
import { config } from "../config/index.ts";
```

Replace references:
- `GEMINI_MODEL` → `config.models.gemini`
- `DOC_MAX_FILES` → `config.limits.docMaxFiles`
- `MAX_FILE_SIZE` → `config.limits.maxFileSize`

- [ ] **Step 6: Update `geo_distance.ts`**

```ts
// OLD:
import { MAX_FILE_SIZE } from "../config.ts";

// NEW:
import { config } from "../config/index.ts";
```

Replace `MAX_FILE_SIZE` → `config.limits.maxFileSize` (2 occurrences).

- [ ] **Step 7: Commit**

```bash
git add src/tools/bash.ts src/tools/web.ts src/tools/shipping.ts src/tools/agents_hub.ts src/tools/document_processor.ts src/tools/geo_distance.ts
git commit -m "refactor(tools): use config module instead of flat constants (SP-28)"
```

---

## Task 9: Update test files

**Files:**
- Modify: `src/tools/bash.test.ts`
- Modify: `src/tools/web.test.ts`
- Modify: `src/tools/shipping.test.ts`
- Modify: `src/tools/agents_hub.test.ts`
- Modify: `src/tools/geo_distance.test.ts`
- Modify: `src/services/prompt.test.ts`

**Important context — API key in tests**: After migration, `getApiKey()` returns `config.hub.apiKey` (loaded from `.env` at module init). The `process.env.HUB_API_KEY = "test-key-123"` mock in test `beforeAll` no longer affects the value returned by `getApiKey()`. Tests asserting `capturedBody.apikey === "test-key-123"` must change to `capturedBody.apikey === config.hub.apiKey`. The `process.env.HUB_API_KEY` mock lines can be removed entirely since config validates at import time from `.env`.

- [ ] **Step 1: Update `bash.test.ts`**

```ts
// OLD:
import { OUTPUT_DIR } from "../config.ts";
// in assertion:
expect(result).toBe(resolve(OUTPUT_DIR));

// NEW:
import { config } from "../config/index.ts";
// in assertion:
expect(result).toBe(resolve(config.paths.outputDir));
```

- [ ] **Step 2: Update `web.test.ts`**

Import changes:
```ts
// OLD:
import { ALLOWED_WRITE_PATHS } from "../config.ts";

// NEW:
import { config } from "../config/index.ts";
import { _testWritePaths } from "../services/file.ts";
```

Path mutation changes:
```ts
// OLD:
ALLOWED_WRITE_PATHS.push(tmp);
process.env.HUB_API_KEY = "test-key-123";
// cleanup:
ALLOWED_WRITE_PATHS.splice(ALLOWED_WRITE_PATHS.indexOf(tmp), 1);
delete process.env.HUB_API_KEY;

// NEW:
_testWritePaths.push(tmp);
// cleanup:
_testWritePaths.splice(_testWritePaths.indexOf(tmp), 1);
```

API key assertion change:
```ts
// OLD:
expect(capturedUrl).toBe("https://hub.ag3nts.org/data/test-key-123/people.csv");

// NEW:
expect(capturedUrl).toBe(`https://hub.ag3nts.org/data/${config.hub.apiKey}/people.csv`);
```

- [ ] **Step 3: Update `shipping.test.ts`**

Import changes:
```ts
// ADD:
import { config } from "../config/index.ts";
```

Remove `process.env.HUB_API_KEY` mock setup/teardown:
```ts
// REMOVE from beforeAll:
process.env.HUB_API_KEY = "test-key-123";
// REMOVE from afterAll:
delete process.env.HUB_API_KEY;
```

Update all `apikey` assertions (3 occurrences):
```ts
// OLD:
expect(capturedBody.apikey).toBe("test-key-123");

// NEW:
expect(capturedBody.apikey).toBe(config.hub.apiKey);
```

- [ ] **Step 4: Update `agents_hub.test.ts`**

Import changes:
```ts
// OLD:
import { ALLOWED_READ_PATHS, ALLOWED_WRITE_PATHS } from "../config.ts";

// NEW:
import { config } from "../config/index.ts";
import { _testReadPaths, _testWritePaths } from "../services/file.ts";
```

Path mutation and env mock changes:
```ts
// OLD:
ALLOWED_READ_PATHS.push(tmp);
ALLOWED_WRITE_PATHS.push(tmp);
process.env.HUB_API_KEY = "test-key-123";
// cleanup:
ALLOWED_READ_PATHS.splice(ALLOWED_READ_PATHS.indexOf(tmp), 1);
ALLOWED_WRITE_PATHS.splice(ALLOWED_WRITE_PATHS.indexOf(tmp), 1);
delete process.env.HUB_API_KEY;

// NEW:
_testReadPaths.push(tmp);
_testWritePaths.push(tmp);
// cleanup:
_testReadPaths.splice(_testReadPaths.indexOf(tmp), 1);
_testWritePaths.splice(_testWritePaths.indexOf(tmp), 1);
```

Update all `apikey` assertions (5 occurrences):
```ts
// OLD:
expect(capturedBody.apikey).toBe("test-key-123");

// NEW:
expect(capturedBody.apikey).toBe(config.hub.apiKey);
```

- [ ] **Step 5: Update `geo_distance.test.ts`**

```ts
// OLD:
import { ALLOWED_READ_PATHS } from "../config.ts";
ALLOWED_READ_PATHS.push(tmp);
// cleanup:
ALLOWED_READ_PATHS.splice(ALLOWED_READ_PATHS.indexOf(tmp), 1);

// NEW:
import { _testReadPaths } from "../services/file.ts";
_testReadPaths.push(tmp);
// cleanup:
_testReadPaths.splice(_testReadPaths.indexOf(tmp), 1);
```

- [ ] **Step 6: Update `prompt.test.ts`**

```ts
// OLD:
import { ALLOWED_READ_PATHS } from "../config.ts";
ALLOWED_READ_PATHS.push(tmp);
// cleanup:
ALLOWED_READ_PATHS.splice(ALLOWED_READ_PATHS.indexOf(tmp), 1);

// NEW:
import { _testReadPaths } from "./file.ts";
_testReadPaths.push(tmp);
// cleanup:
_testReadPaths.splice(_testReadPaths.indexOf(tmp), 1);
```

- [ ] **Step 7: Run all tests**

Run: `bun test`
Expected: ALL tests pass

- [ ] **Step 8: Commit**

```bash
git add src/tools/bash.test.ts src/tools/web.test.ts src/tools/shipping.test.ts src/tools/agents_hub.test.ts src/tools/geo_distance.test.ts src/services/prompt.test.ts
git commit -m "test: update test imports to use config module and mutable test paths (SP-28)"
```

---

## Task 10: Delete old `src/config.ts` and final verification

**Files:**
- Delete: `src/config.ts`

- [ ] **Step 1: Verify no remaining imports of old config**

Run: `grep -r 'from.*config\.ts' src/ --include='*.ts'`
Expected: only `src/config/personas.ts` references (importing from `./personas.ts` within config dir) — no references to the old `../config.ts`

Actually, `personas.ts` doesn't import from `config.ts`, so there should be zero matches for `from.*["'].*config\.ts["']` patterns pointing to the old file.

- [ ] **Step 2: Verify no remaining `process.env` reads in src/ (except test files)**

Run: `grep -rn 'process\.env\.' src/ --include='*.ts' | grep -v '\.test\.ts' | grep -v 'config/index.ts'`
Expected: no matches

- [ ] **Step 3: Delete old config file**

```bash
git rm src/config.ts
```

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: ALL tests pass

- [ ] **Step 5: Smoke test the agent**

Run: `bun run agent "ping"`
Expected: agent starts without error, session ID prints, log file created

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor: delete old src/config.ts — migration to config module complete (SP-28)"
```

---

## Key Implementation Notes

1. **Path resolution**: `src/config/index.ts` lives one level deeper than old `src/config.ts`. Use `resolve(import.meta.dir, "../..")` for project root (was `resolve(import.meta.dir, "..")`).

2. **`web.placeholderMap` self-reference**: The `hub_api_key` lambda in `placeholderMap` references `config.hub.apiKey`. This works because the closure captures `config` by variable reference, and the lambda is only called at runtime (not at construction). Since `config` is assigned before any lambda is called, the reference is valid.

3. **`_testReadPaths` / `_testWritePaths`**: These are mutable arrays exported from `file.ts`, initialized as copies of the frozen config arrays. Tests push/splice on these. The default `files` singleton uses them internally. This preserves the existing test pattern while keeping config frozen.

4. **API key in tests**: The config module reads `HUB_API_KEY` from `.env` at import time (Bun auto-loads `.env`). Test files that previously set `process.env.HUB_API_KEY = "test-key-123"` in `beforeAll` — this mock no longer affects `config.hub.apiKey` (already frozen). Tests that assert `capturedBody.apikey === "test-key-123"` must change to `config.hub.apiKey`. The `process.env` mock lines can be removed. Tests depend on `.env` being present with valid keys.

5. **Import paths**: Files in `src/` use `"./config/index.ts"` or `"../config/index.ts"`. Files in `src/config/` use `"./index.ts"` if needed, though `personas.ts` has no config dependency.
