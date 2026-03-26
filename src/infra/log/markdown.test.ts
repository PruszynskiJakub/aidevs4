import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { MarkdownLogger, formatJson } from "./markdown.ts";
import { randomSessionId } from "../../utils/id.ts";
import { createBunFileService } from "../file.ts";

function makeLogger(dir: string, sessionId?: string) {
  const fs = createBunFileService([], [dir]);
  return new MarkdownLogger({ logsDir: dir, sessionId, fs });
}

describe("MarkdownLogger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mdlog-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a log file on first write", async () => {
    const md = makeLogger(dir, "test1");
    md.init("hello");
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain("# Agent Log");
    expect(content).toContain("hello");
  });

  it("appends in order across multiple calls", async () => {
    const md = makeLogger(dir, "test2");
    md.init("prompt");
    md.step(1, 10, "gpt-4.1", 2);
    md.llm("1.50s", 100, 50);
    md.answer("done");
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    const initIdx = content.indexOf("# Agent Log");
    const stepIdx = content.indexOf("## Step 1/10");
    const llmIdx = content.indexOf("**LLM responded**");
    const answerIdx = content.indexOf("## Final Answer");

    expect(initIdx).toBeLessThan(stepIdx);
    expect(stepIdx).toBeLessThan(llmIdx);
    expect(llmIdx).toBeLessThan(answerIdx);
  });

  it("preserves full payloads without truncation", async () => {
    const md = makeLogger(dir, "test3");
    const longString = "x".repeat(10_000);
    const args = JSON.stringify({ data: longString });
    md.toolCall("test_tool", args);
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain(longString);
  });

  it("pretty-prints JSON in tool calls and XML in results", async () => {
    const md = makeLogger(dir, "test4");
    md.toolCall("my_tool", '{"key":"value","nested":{"a":1}}');
    md.toolOk("my_tool", "0.50s", '<document id="x" description="test">ok</document>');
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain('"key": "value"');
    expect(content).toContain('<document id="x"');
  });

  it("logs tool errors", async () => {
    const md = makeLogger(dir, "test5");
    md.toolErr("bad_tool", "Something went wrong");
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain("ERROR");
    expect(content).toContain("Something went wrong");
  });

  it("logs batch completion", async () => {
    const md = makeLogger(dir, "test6");
    md.batchDone(3, "2.10s");
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain("3 tools in 2.10s");
  });

  it("logs max iterations", async () => {
    const md = makeLogger(dir, "test7");
    md.maxIter(20);
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain("STOPPED");
    expect(content).toContain("20");
  });

  it("flush guarantees all content is on disk", async () => {
    const md = makeLogger(dir, "test8");
    for (let i = 0; i < 50; i++) {
      md.step(i, 50, "gpt-4.1", i);
    }
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    for (let i = 0; i < 50; i++) {
      expect(content).toContain(`Step ${i}/50`);
    }
  });

  // --- Session-based directory structure tests ---

  it("writes to {sessionsDir}/{date}/{sessionId}/log/log_{time}.md", async () => {
    const md = makeLogger(dir, "abc123");
    md.init("test");
    await md.flush();

    // filePath should contain the date folder, session folder, and log subfolder
    const rel = md.filePath.slice(dir.length + 1); // e.g. "2026-03-17/abc123/log/log_10-15-30.md"
    const parts = rel.split("/");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // date folder
    expect(parts[1]).toBe("abc123"); // session folder
    expect(parts[2]).toBe("log"); // log subfolder
    expect(parts[3]).toMatch(/^log_\d{2}-\d{2}-\d{2}\.md$/); // time-only filename
  });

  it("generates a UUID v4 session ID when none provided", async () => {
    const md = makeLogger(dir);
    expect(md.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    md.init("test");
    await md.flush();

    const rel = md.filePath.slice(dir.length + 1);
    const parts = rel.split("/");
    expect(parts[1]).toBe(md.sessionId);
  });

  it("multiple runs with same session ID write to same session folder", async () => {
    const md1 = makeLogger(dir, "shared");
    md1.init("run 1");
    await md1.flush();

    // Tiny delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 1100));

    const md2 = makeLogger(dir, "shared");
    md2.init("run 2");
    await md2.flush();

    // Both should be in the same session directory
    expect(dirname(md1.filePath)).toBe(dirname(md2.filePath));

    // But different filenames
    expect(basename(md1.filePath)).not.toBe(basename(md2.filePath));

    // Session folder should contain both files
    const sessionDir = dirname(md1.filePath);
    const files = await readdir(sessionDir);
    expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(2);
  });

  it("rejects path traversal in session ID", () => {
    expect(() => makeLogger(dir, "../etc")).toThrow("Invalid session ID");
    expect(() => makeLogger(dir, "foo/bar")).toThrow("Invalid session ID");
    expect(() => makeLogger(dir, "")).toThrow("Invalid session ID");
    expect(() => makeLogger(dir, ".hidden")).toThrow("Invalid session ID");
  });

  it("exposes sessionId on the instance", () => {
    const md = makeLogger(dir, "mySession");
    expect(md.sessionId).toBe("mySession");
  });

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
    const rel = md.filePath.slice(dir.length + 1);
    const dateFolder = rel.split("/")[0];
    expect(dateFolder).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const content = await readFile(md.filePath, "utf-8");
    expect(content).toMatch(/# Agent Log — \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it("registers beforeExit handler for auto-flush", () => {
    const spy = spyOn(process, "on");
    const md = makeLogger(dir, "exit-test");
    const beforeExitCalls = spy.mock.calls.filter(
      ([event]) => event === "beforeExit"
    );
    expect(beforeExitCalls).toHaveLength(1);
    spy.mockRestore();
    md.dispose();
  });

  it("dispose removes beforeExit handler", () => {
    const md = makeLogger(dir, "dispose-test");
    const spy = spyOn(process, "removeListener");
    md.dispose();
    const removeCalls = spy.mock.calls.filter(
      ([event]) => event === "beforeExit"
    );
    expect(removeCalls).toHaveLength(1);
    spy.mockRestore();
  });

  it("writes sidecar file for large tool results", async () => {
    const md = makeLogger(dir, "sidecar-test");
    const largePayload = '<document id="x" description="big">' + "x".repeat(20_000) + '</document>';
    md.toolOk("big_tool", "2.00s", largePayload);
    await md.flush();
    const content = await readFile(md.filePath, "utf-8");
    expect(content).not.toContain("x".repeat(20_000));
    expect(content).toMatch(/\[full output\]/);
    const sessionDir = dirname(md.filePath);
    const files = await readdir(sessionDir);
    const sidecar = files.find(f => f.startsWith("big_tool_") && f.endsWith(".txt"));
    expect(sidecar).toBeDefined();
  });

  it("inlines small tool results as before", async () => {
    const md = makeLogger(dir, "inline-test");
    md.toolOk("small_tool", "0.50s", '<document id="x" description="test">ok</document>');
    await md.flush();
    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain('<document id="x"');
    expect(content).not.toContain("[full output]");
  });
});

describe("randomSessionId", () => {
  it("returns a valid UUID v4 string", () => {
    const id = randomSessionId();
    expect(id).toHaveLength(36);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe("formatJson", () => {
  it("pretty-prints valid JSON", () => {
    const result = formatJson('{"a":1,"b":"two"}');
    expect(result).toBe('{\n  "a": 1,\n  "b": "two"\n}');
  });

  it("returns raw string for invalid JSON", () => {
    const result = formatJson("not json at all");
    expect(result).toBe("not json at all");
  });
});
