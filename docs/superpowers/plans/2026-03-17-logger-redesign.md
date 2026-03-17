# SP-33 Logger Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the convention-based dual-track logger with an interface-driven, composite-dispatch architecture that guarantees method parity, fixes correctness bugs, and adds log levels.

**Architecture:** A `Logger` interface defines all 14 methods. `ConsoleLogger` and `MarkdownLogger` both implement it. `CompositeLogger` delegates to an array of `Logger` targets, eliminating manual forwarding. The `elapsed()` utility replaces the misnamed `duration()`.

**Tech Stack:** TypeScript, Bun, existing `FileProvider` service

---

### Task 1: Define the `Logger` interface

**Files:**
- Create: `src/types/logger.ts`

- [ ] **Step 1: Write the interface file**

```typescript
// src/types/logger.ts
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  step(iter: number, max: number, model: string, msgCount: number): void;
  llm(elapsed: string, tokensIn?: number, tokensOut?: number): void;
  plan(planText: string, model: string, elapsed: string, tokensIn?: number, tokensOut?: number): void;
  toolHeader(count: number): void;
  toolCall(name: string, rawArgs: string): void;
  toolOk(name: string, elapsed: string, rawResult: string, hints?: string[]): void;
  toolErr(name: string, errorMsg: string): void;
  batchDone(count: number, elapsed: string): void;
  answer(text: string | null): void;
  maxIter(max: number): void;
  info(message: string): void;
  success(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bunx tsc --noEmit src/types/logger.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/types/logger.ts
git commit -m "feat(SP-33): add Logger interface and LogLevel type"
```

---

### Task 2: Create `ConsoleLogger`

**Files:**
- Create: `src/services/console-logger.ts`
- Create: `src/services/console-logger.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/services/console-logger.test.ts
import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { ConsoleLogger } from "./console-logger.ts";

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";

describe("ConsoleLogger", () => {
  let spy: ReturnType<typeof spyOn>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("info prints with cyan prefix", () => {
    const logger = new ConsoleLogger();
    logger.info("hello");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(CYAN);
    expect(captured[0]).toContain("hello");
    expect(captured[0]).toContain(RESET);
  });

  it("success prints with green prefix", () => {
    const logger = new ConsoleLogger();
    logger.success("done");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(GREEN);
    expect(captured[0]).toContain("done");
  });

  it("error prints with red prefix", () => {
    const logger = new ConsoleLogger();
    logger.error("fail");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(RED);
    expect(captured[0]).toContain("fail");
  });

  it("debug prints with dim prefix", () => {
    const logger = new ConsoleLogger();
    logger.debug("trace");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(DIM);
    expect(captured[0]).toContain("trace");
  });

  it("step prints iteration info", () => {
    const logger = new ConsoleLogger();
    logger.step(1, 10, "gpt-4.1", 5);
    const output = captured.join("\n");
    expect(output).toContain("Step 1/10");
    expect(output).toContain("gpt-4.1");
    expect(output).toContain("5 msgs");
  });

  it("toolCall prints tool name and summarized args", () => {
    const logger = new ConsoleLogger();
    logger.toolCall("my_tool", '{"query":"hello"}');
    const output = captured.join("\n");
    expect(output).toContain("my_tool");
    expect(output).toContain("query:");
  });

  it("toolOk prints green checkmark and summary", () => {
    const logger = new ConsoleLogger();
    logger.toolOk("my_tool", "1.50s", '{"status":"ok"}');
    const output = captured.join("\n");
    expect(output).toContain(GREEN);
    expect(output).toContain("my_tool");
    expect(output).toContain("1.50s");
  });

  it("toolErr prints red error", () => {
    const logger = new ConsoleLogger();
    logger.toolErr("bad_tool", "Something broke");
    const output = captured.join("\n");
    expect(output).toContain(RED);
    expect(output).toContain("bad_tool");
    expect(output).toContain("Something broke");
  });

  describe("log level filtering", () => {
    it("suppresses debug when level is info", () => {
      const logger = new ConsoleLogger({ level: "info" });
      logger.debug("should not appear");
      expect(captured).toHaveLength(0);
    });

    it("suppresses debug and info when level is warn", () => {
      const logger = new ConsoleLogger({ level: "warn" });
      logger.debug("nope");
      logger.info("nope");
      expect(captured).toHaveLength(0);
    });

    it("shows error when level is warn", () => {
      const logger = new ConsoleLogger({ level: "warn" });
      logger.error("visible");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain("visible");
    });

    it("agent-loop methods are always shown regardless of level", () => {
      const logger = new ConsoleLogger({ level: "error" });
      logger.step(1, 10, "gpt-4.1", 5);
      logger.llm("1.00s");
      logger.toolHeader(1);
      logger.toolCall("t", "{}");
      logger.toolOk("t", "0.5s", "{}");
      logger.answer("done");
      // All these should produce output — they are agent-loop structural methods, not filterable
      expect(captured.length).toBeGreaterThan(0);
    });
  });

  describe("configurable truncation", () => {
    it("uses custom truncation length for args", () => {
      const logger = new ConsoleLogger({ truncateArgs: 10 });
      const longArg = JSON.stringify({ data: "x".repeat(200) });
      logger.toolCall("t", longArg);
      const output = captured.join("\n");
      // Should be truncated — not contain the full 200-char string
      expect(output).not.toContain("x".repeat(200));
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/console-logger.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `ConsoleLogger`**

```typescript
// src/services/console-logger.ts
import type { Logger, LogLevel } from "../types/logger.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const WHITE = "\x1b[37m";
const BG_RED = "\x1b[41m";
const BG_GREEN = "\x1b[42m";

const BAR = `${DIM}${"─".repeat(50)}${RESET}`;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  truncateArgs?: number;
  truncateResult?: number;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

function formatVal(v: unknown, maxLen: number): string {
  if (typeof v === "string") return truncate(v, maxLen);
  if (typeof v === "object") return truncate(JSON.stringify(v), maxLen);
  return String(v);
}

function summarizeArgs(raw: string, valLen: number): string {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return truncate(raw, 80);
    return Object.entries(obj).map(([k, v]) => `${k}: ${formatVal(v, valLen)}`).join(", ");
  } catch {
    return truncate(raw, 80);
  }
}

function summarizeResult(raw: string, maxLen: number): string {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return truncate(raw, maxLen);
    if (obj.error) return `${RED}error: ${obj.error}${RESET}`;
    const summary = Object.entries(obj)
      .filter(([k]) => k !== "preview" && k !== "content")
      .map(([k, v]) => `${k}: ${formatVal(v, 40)}`)
      .join(", ");
    return truncate(summary, maxLen);
  } catch {
    return truncate(raw, maxLen);
  }
}

function tokenSuffix(tokensIn?: number, tokensOut?: number): string {
  return tokensIn != null ? `  ${DIM}(${tokensIn} → ${tokensOut} tokens)${RESET}` : "";
}

export class ConsoleLogger implements Logger {
  private readonly minLevel: number;
  private readonly argsTruncate: number;
  private readonly resultTruncate: number;

  constructor(opts?: ConsoleLoggerOptions) {
    this.minLevel = LEVEL_ORDER[opts?.level ?? "debug"];
    this.argsTruncate = opts?.truncateArgs ?? 50;
    this.resultTruncate = opts?.truncateResult ?? 120;
  }

  private canLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= this.minLevel;
  }

  step(iter: number, max: number, model: string, msgCount: number): void {
    console.log("");
    console.log(BAR);
    console.log(
      `${BOLD}${WHITE} Step ${iter}/${max}${RESET}` +
      `${DIM}  ·  ${model}  ·  ${msgCount} msgs${RESET}`
    );
    console.log(BAR);
  }

  llm(elapsed: string, tokensIn?: number, tokensOut?: number): void {
    console.log(`  ${CYAN}⚡${RESET} LLM responded in ${BOLD}${elapsed}${RESET}${tokenSuffix(tokensIn, tokensOut)}`);
  }

  plan(planText: string, model: string, elapsed: string, tokensIn?: number, tokensOut?: number): void {
    console.log(`  ${CYAN}📋${RESET} Plan updated ${DIM}(${model}, ${elapsed})${RESET}${tokenSuffix(tokensIn, tokensOut)}`);
    for (const line of planText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.includes("[x]")) {
        console.log(`     ${DIM}${trimmed}${RESET}`);
      } else if (trimmed.includes("[>]")) {
        console.log(`     ${BOLD}${YELLOW}${trimmed}${RESET}`);
      } else if (trimmed.includes("[ ]")) {
        console.log(`     ${WHITE}${trimmed}${RESET}`);
      }
    }
  }

  toolHeader(count: number): void {
    const parallel = count > 1 ? ` in parallel` : "";
    console.log(`  ${YELLOW}🔧 Calling ${count} tool${count > 1 ? "s" : ""}${parallel}:${RESET}`);
  }

  toolCall(name: string, rawArgs: string): void {
    console.log(`     ${DIM}→${RESET} ${BOLD}${name}${RESET}${DIM}(${summarizeArgs(rawArgs, this.argsTruncate)})${RESET}`);
  }

  toolOk(name: string, elapsed: string, rawResult: string, hints?: string[]): void {
    console.log(`  ${GREEN}✔ ${name}${RESET} ${DIM}${elapsed}${RESET}`);
    const summary = summarizeResult(rawResult, this.resultTruncate);
    if (summary) {
      console.log(`     ${DIM}${summary}${RESET}`);
    }
    if (hints?.length) {
      for (const hint of hints) {
        console.log(`     ${YELLOW}💡 ${hint}${RESET}`);
      }
    }
  }

  toolErr(name: string, errorMsg: string): void {
    console.log(`  ${RED}✘ ${name}${RESET}`);
    console.log(`     ${RED}${truncate(errorMsg, this.resultTruncate)}${RESET}`);
  }

  batchDone(count: number, elapsed: string): void {
    console.log(`  ${DIM}⏱ ${count} tools completed in ${elapsed}${RESET}`);
  }

  answer(text: string | null): void {
    console.log("");
    console.log(BAR);
    console.log(`${BG_GREEN}${BOLD}${WHITE} ANSWER ${RESET}`);
    console.log(BAR);
    console.log(text ?? "(no response)");
  }

  maxIter(max: number): void {
    console.log("");
    console.log(BAR);
    console.log(`${BG_RED}${BOLD}${WHITE} STOPPED — reached ${max} iterations ${RESET}`);
    console.log(BAR);
  }

  info(message: string): void {
    if (!this.canLog("info")) return;
    console.log(`  ${CYAN}ℹ${RESET} ${message}`);
  }

  success(message: string): void {
    if (!this.canLog("info")) return;
    console.log(`  ${GREEN}✓${RESET} ${message}`);
  }

  error(message: string): void {
    if (!this.canLog("error")) return;
    console.log(`  ${RED}✗${RESET} ${message}`);
  }

  debug(message: string): void {
    if (!this.canLog("debug")) return;
    console.log(`  ${DIM}${message}${RESET}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/console-logger.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/console-logger.ts src/services/console-logger.test.ts
git commit -m "feat(SP-33): add ConsoleLogger implementing Logger interface"
```

---

### Task 3: Create `CompositeLogger`

**Files:**
- Create: `src/services/composite-logger.ts`
- Create: `src/services/composite-logger.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/services/composite-logger.test.ts
import { describe, it, expect } from "bun:test";
import { CompositeLogger } from "./composite-logger.ts";
import type { Logger } from "../types/logger.ts";

function mockLogger(): Logger & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const handler = {
    get(_: unknown, prop: string) {
      if (prop === "calls") return calls;
      return (...args: unknown[]) => {
        calls[prop] ??= [];
        calls[prop].push(args);
      };
    },
  };
  return new Proxy({} as Logger & { calls: Record<string, unknown[][]> }, handler);
}

describe("CompositeLogger", () => {
  it("delegates step to all targets", () => {
    const a = mockLogger();
    const b = mockLogger();
    const composite = new CompositeLogger([a, b]);
    composite.step(1, 10, "gpt-4.1", 5);
    expect(a.calls.step).toEqual([[1, 10, "gpt-4.1", 5]]);
    expect(b.calls.step).toEqual([[1, 10, "gpt-4.1", 5]]);
  });

  it("delegates all 14 methods", () => {
    const target = mockLogger();
    const composite = new CompositeLogger([target]);

    composite.step(1, 1, "m", 1);
    composite.llm("1s", 10, 20);
    composite.plan("p", "m", "1s", 10, 20);
    composite.toolHeader(1);
    composite.toolCall("t", "{}");
    composite.toolOk("t", "1s", "{}", ["h"]);
    composite.toolErr("t", "e");
    composite.batchDone(1, "1s");
    composite.answer("a");
    composite.maxIter(10);
    composite.info("i");
    composite.success("s");
    composite.error("e");
    composite.debug("d");

    const methods = ["step", "llm", "plan", "toolHeader", "toolCall", "toolOk",
      "toolErr", "batchDone", "answer", "maxIter", "info", "success", "error", "debug"];
    for (const m of methods) {
      expect(target.calls[m]).toHaveLength(1);
    }
  });

  it("works with zero targets (no-op)", () => {
    const composite = new CompositeLogger([]);
    // Should not throw
    composite.step(1, 1, "m", 1);
    composite.info("test");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/composite-logger.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `CompositeLogger`**

```typescript
// src/services/composite-logger.ts
import type { Logger } from "../types/logger.ts";

export class CompositeLogger implements Logger {
  constructor(private readonly targets: Logger[]) {}

  step(iter: number, max: number, model: string, msgCount: number): void {
    for (const t of this.targets) t.step(iter, max, model, msgCount);
  }
  llm(elapsed: string, tokensIn?: number, tokensOut?: number): void {
    for (const t of this.targets) t.llm(elapsed, tokensIn, tokensOut);
  }
  plan(planText: string, model: string, elapsed: string, tokensIn?: number, tokensOut?: number): void {
    for (const t of this.targets) t.plan(planText, model, elapsed, tokensIn, tokensOut);
  }
  toolHeader(count: number): void {
    for (const t of this.targets) t.toolHeader(count);
  }
  toolCall(name: string, rawArgs: string): void {
    for (const t of this.targets) t.toolCall(name, rawArgs);
  }
  toolOk(name: string, elapsed: string, rawResult: string, hints?: string[]): void {
    for (const t of this.targets) t.toolOk(name, elapsed, rawResult, hints);
  }
  toolErr(name: string, errorMsg: string): void {
    for (const t of this.targets) t.toolErr(name, errorMsg);
  }
  batchDone(count: number, elapsed: string): void {
    for (const t of this.targets) t.batchDone(count, elapsed);
  }
  answer(text: string | null): void {
    for (const t of this.targets) t.answer(text);
  }
  maxIter(max: number): void {
    for (const t of this.targets) t.maxIter(max);
  }
  info(message: string): void {
    for (const t of this.targets) t.info(message);
  }
  success(message: string): void {
    for (const t of this.targets) t.success(message);
  }
  error(message: string): void {
    for (const t of this.targets) t.error(message);
  }
  debug(message: string): void {
    for (const t of this.targets) t.debug(message);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/composite-logger.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/composite-logger.ts src/services/composite-logger.test.ts
git commit -m "feat(SP-33): add CompositeLogger for multi-target dispatch"
```

---

### Task 4: Refactor `MarkdownLogger` to implement `Logger`

**Files:**
- Modify: `src/services/markdown-logger.ts`
- Modify: `src/services/markdown-logger.test.ts`

- [ ] **Step 1: Write failing tests for new methods and fixes**

Add to `src/services/markdown-logger.test.ts`:

```typescript
// Add these tests to the existing describe("MarkdownLogger") block:

it("logs info messages", async () => {
  const md = makeLogger(dir, "info-test");
  md.info("informational");
  await md.flush();
  const content = await readFile(md.filePath, "utf-8");
  expect(content).toContain("informational");
});

it("logs success messages", async () => {
  const md = makeLogger(dir, "success-test");
  md.success("completed");
  await md.flush();
  const content = await readFile(md.filePath, "utf-8");
  expect(content).toContain("completed");
});

it("logs error messages", async () => {
  const md = makeLogger(dir, "error-test");
  md.error("something failed");
  await md.flush();
  const content = await readFile(md.filePath, "utf-8");
  expect(content).toContain("something failed");
});

it("logs debug messages", async () => {
  const md = makeLogger(dir, "debug-test");
  md.debug("debug details");
  await md.flush();
  const content = await readFile(md.filePath, "utf-8");
  expect(content).toContain("debug details");
});

it("uses UTC consistently for folder and header", async () => {
  const md = makeLogger(dir, "utc-test");
  md.init("utc test");
  await md.flush();

  // Folder name should be a valid YYYY-MM-DD date
  const rel = md.filePath.slice(dir.length + 1);
  const dateFolder = rel.split("/")[0];
  expect(dateFolder).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // Read content — header date should also match YYYY-MM-DD pattern (UTC)
  const content = await readFile(md.filePath, "utf-8");
  // The header contains a formatted date — just verify it's present and well-formed
  expect(content).toMatch(/# Agent Log — \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

it("writes sidecar file for large tool results", async () => {
  const md = makeLogger(dir, "sidecar-test");
  const largePayload = JSON.stringify({ data: "x".repeat(20_000) });
  md.toolOk("big_tool", "2.00s", largePayload);
  await md.flush();

  const content = await readFile(md.filePath, "utf-8");
  // Should NOT contain the inline payload
  expect(content).not.toContain("x".repeat(20_000));
  // Should contain a link to a sidecar file
  expect(content).toMatch(/\[full output\]/);

  // Sidecar file should exist in the session directory
  const sessionDir = dirname(md.filePath);
  const files = await readdir(sessionDir);
  const sidecar = files.find(f => f.startsWith("big_tool_") && f.endsWith(".json"));
  expect(sidecar).toBeDefined();
});

it("inlines small tool results as before", async () => {
  const md = makeLogger(dir, "inline-test");
  md.toolOk("small_tool", "0.50s", '{"result":"ok"}');
  await md.flush();

  const content = await readFile(md.filePath, "utf-8");
  expect(content).toContain('"result": "ok"');
  // No sidecar link
  expect(content).not.toContain("[full output]");
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `bun test src/services/markdown-logger.test.ts`
Expected: Tests for `info`, `success`, `error`, `debug` FAIL (methods don't exist). Sidecar test FAILs. UTC test may fail depending on timing.

- [ ] **Step 3: Refactor `MarkdownLogger`**

Apply these changes to `src/services/markdown-logger.ts`:

1. Add `implements Logger` to the class declaration:
```typescript
import type { Logger } from "../types/logger.ts";
// ...
export class MarkdownLogger implements Logger {
```

2. Replace `dateFolder()`, `timeStamp()`, and `formatDate()` with a single UTC helper:
```typescript
function utcTimestamp(): { folder: string; stamp: string; display: string } {
  const iso = new Date().toISOString();
  return {
    folder: iso.slice(0, 10),                           // 2026-03-17
    stamp: iso.slice(11, 19).replace(/:/g, "-"),         // 14-30-05
    display: iso.replace("T", " ").slice(0, 19),         // 2026-03-17 14:30:05
  };
}
```

3. Update the constructor to use `utcTimestamp()`:
```typescript
constructor(options?: { logsDir?: string; sessionId?: string; fs?: FileProvider }) {
  const logsDir = options?.logsDir ?? config.paths.logsDir;
  const sid = options?.sessionId ?? randomSessionId();

  if (!SAFE_ID.test(sid)) {
    throw new Error("Invalid session ID: must match /^[a-zA-Z0-9_\\-]+$/");
  }

  this.fs = options?.fs ?? createBunFileService([], [logsDir]);
  this.sessionId = sid;
  const ts = utcTimestamp();
  const dir = join(logsDir, ts.folder, sid);
  this.sessionDir = dir;
  this.filePath = join(dir, `log_${ts.stamp}.md`);
  this.chain = this.fs.mkdir(dir);

  // Auto-flush on process exit
  this._exitHandler = () => { this.flush(); };
  process.on("beforeExit", this._exitHandler);
}
```

4. Add `sessionDir` and `_exitHandler` fields:
```typescript
readonly sessionDir: string;
private _exitHandler: () => void;
```

5. Add `MAX_INLINE_SIZE` constant and update `toolOk` for sidecar:
```typescript
const MAX_INLINE_SIZE = 10_240; // 10 KB

// In toolOk:
toolOk(name: string, elapsed: string, rawResult: string, hints?: string[]): void {
  let text: string;
  if (rawResult.length > MAX_INLINE_SIZE) {
    const ts = utcTimestamp();
    const sidecarName = `${name}_${ts.stamp}.json`;
    const sidecarPath = join(this.sessionDir, sidecarName);
    // Write sidecar — chain it so ordering is preserved
    this.chain = this.chain.then(() =>
      this.fs.write(sidecarPath, formatJson(rawResult)).catch(() => {}),
    );
    text =
      `**Result** (${elapsed}) — OK\n\n` +
      `> Output too large (${rawResult.length} bytes). See [full output](${sidecarName})\n\n`;
  } else {
    text =
      `**Result** (${elapsed}) — OK\n\n` +
      `\`\`\`json\n${formatJson(rawResult)}\n\`\`\`\n\n`;
  }
  if (hints?.length) {
    text += `> **Hints:**\n`;
    for (const hint of hints) {
      text += `> - ${hint}\n`;
    }
    text += `\n`;
  }
  this.append(text);
}
```

6. Add the four missing methods:
```typescript
info(message: string): void {
  this.append(`**ℹ Info:** ${message}\n\n`);
}

success(message: string): void {
  this.append(`**✓ Success:** ${message}\n\n`);
}

error(message: string): void {
  this.append(`**✗ Error:** ${message}\n\n`);
}

debug(message: string): void {
  this.append(`*Debug: ${message}*\n\n`);
}
```

7. Update `init` to use `utcTimestamp().display`:
```typescript
init(prompt: string): void {
  const ts = utcTimestamp();
  this.append(
    `# Agent Log — ${ts.display}\n\n` +
    `## User Prompt\n\n${prompt}\n\n---\n\n`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/markdown-logger.test.ts`
Expected: All PASS (including new tests). The existing "preserves full payloads without truncation" test will need updating — it now only applies to payloads under 10 KB. Update that test:

Change the existing test at line 53 to use a smaller payload (under 10 KB):
```typescript
it("preserves payloads without truncation when under size limit", async () => {
  const md = makeLogger(dir, "test3");
  const longString = "x".repeat(5_000); // Under 10 KB limit
  const args = JSON.stringify({ data: longString });
  md.toolCall("test_tool", args);
  await md.flush();

  const content = await readFile(md.filePath, "utf-8");
  expect(content).toContain(longString);
});
```

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/markdown-logger.ts src/services/markdown-logger.test.ts
git commit -m "feat(SP-33): refactor MarkdownLogger — implement Logger, UTC fix, sidecar, missing methods"
```

---

### Task 5: Rename `duration()` to `elapsed()` and rewire `logger.ts`

**Files:**
- Modify: `src/services/logger.ts`
- Modify: `src/services/logger.test.ts`
- Modify: `src/agent.ts`

- [ ] **Step 1: Update `logger.ts`**

Replace the entire file with a slim re-export module:

```typescript
// src/services/logger.ts
// Backward-compatible facade — re-exports from new modules
import type { Logger } from "../types/logger.ts";
import { ConsoleLogger } from "./console-logger.ts";

export type Log = Logger;

export function elapsed(startPerfNow: number): string {
  const seconds = (performance.now() - startPerfNow) / 1000;
  return `${seconds.toFixed(2)}s`;
}

/** @deprecated Use `elapsed` instead */
export const duration = elapsed;

/** @deprecated Use `new ConsoleLogger()` or `new CompositeLogger(...)` instead */
export function createLogger(md?: import("./markdown-logger.ts").MarkdownLogger): Logger {
  // Temporary shim — will be removed once agent.ts is updated
  if (!md) return new ConsoleLogger();
  const { CompositeLogger } = require("./composite-logger.ts");
  return new CompositeLogger([new ConsoleLogger(), md]);
}

export const log: Logger = new ConsoleLogger();
```

- [ ] **Step 2: Update `logger.test.ts`**

```typescript
// src/services/logger.test.ts
import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { log, elapsed, duration } from "./logger.ts";

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

describe("logger singleton", () => {
  let spy: ReturnType<typeof spyOn>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("log.info prints with cyan prefix", () => {
    log.info("hello");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(CYAN);
    expect(captured[0]).toContain("hello");
    expect(captured[0]).toContain(RESET);
  });

  it("log.success prints with green prefix", () => {
    log.success("done");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(GREEN);
    expect(captured[0]).toContain("done");
  });

  it("log.error prints with red prefix", () => {
    log.error("fail");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(RED);
    expect(captured[0]).toContain("fail");
  });

  it("log.debug prints with dim prefix", () => {
    log.debug("trace");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(DIM);
    expect(captured[0]).toContain("trace");
  });
});

describe("elapsed", () => {
  it("returns formatted elapsed time", () => {
    const start = performance.now() - 1500;
    const result = elapsed(start);
    expect(result).toMatch(/^\d+\.\d{2}s$/);
    const seconds = parseFloat(result);
    expect(seconds).toBeGreaterThan(1.0);
    expect(seconds).toBeLessThan(3.0);
  });

  it("duration is an alias for elapsed", () => {
    expect(duration).toBe(elapsed);
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `bun test src/services/logger.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/logger.ts src/services/logger.test.ts
git commit -m "feat(SP-33): slim logger.ts to facade, rename duration to elapsed"
```

---

### Task 6: Rewire `agent.ts` to use `CompositeLogger`

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Update imports and logger creation in `agent.ts`**

Replace lines 7-8:
```typescript
// Old:
import { createLogger, duration } from "./services/logger.ts";
import { MarkdownLogger } from "./services/markdown-logger.ts";

// New:
import { elapsed } from "./services/logger.ts";
import { MarkdownLogger } from "./services/markdown-logger.ts";
import { ConsoleLogger } from "./services/console-logger.ts";
import { CompositeLogger } from "./services/composite-logger.ts";
```

Replace line 30:
```typescript
// Old:
const log = createLogger(md);

// New:
const log = new CompositeLogger([new ConsoleLogger(), md]);
```

Replace all `duration(` calls with `elapsed(` — 4 occurrences at lines 73, 97, 132, 164.

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/agent.ts
git commit -m "feat(SP-33): rewire agent.ts to CompositeLogger + elapsed()"
```

---

### Task 7: Remove deprecated `createLogger` shim

**Files:**
- Modify: `src/services/logger.ts`

- [ ] **Step 1: Remove the `createLogger` function from `logger.ts`**

The final `logger.ts` should be:

```typescript
// src/services/logger.ts
import type { Logger } from "../types/logger.ts";
import { ConsoleLogger } from "./console-logger.ts";

export type Log = Logger;

export function elapsed(startPerfNow: number): string {
  const seconds = (performance.now() - startPerfNow) / 1000;
  return `${seconds.toFixed(2)}s`;
}

/** @deprecated Use `elapsed` instead */
export const duration = elapsed;

export const log: Logger = new ConsoleLogger();
```

- [ ] **Step 2: Verify no remaining imports of `createLogger`**

Run: `grep -r "createLogger" src/`
Expected: No matches (except possibly comments)

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/logger.ts
git commit -m "feat(SP-33): remove deprecated createLogger shim"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All PASS

- [ ] **Step 2: Type-check the entire project**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Smoke test the agent**

Run: `bun run agent "What tools do you have?"`
Expected: Console output shows colored step/tool/answer logging. Check the log file path printed at startup — verify the markdown file contains `info`, `success`, and all agent-loop events.

- [ ] **Step 4: Verify server still works**

Run: `bun run src/server.ts` (start, then Ctrl+C)
Expected: Starts without errors, prints listening message via `log.info`
