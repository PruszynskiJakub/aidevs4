import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MarkdownLogger, formatJson } from "./markdown-logger.ts";

describe("MarkdownLogger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mdlog-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a log file on first write", async () => {
    const md = new MarkdownLogger(dir);
    md.init("hello");
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain("# Agent Log");
    expect(content).toContain("hello");
  });

  it("appends in order across multiple calls", async () => {
    const md = new MarkdownLogger(dir);
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
    const md = new MarkdownLogger(dir);
    const longString = "x".repeat(10_000);
    const args = JSON.stringify({ data: longString });
    md.toolCall("test_tool", args);
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain(longString);
  });

  it("pretty-prints JSON in tool calls and results", async () => {
    const md = new MarkdownLogger(dir);
    md.toolCall("my_tool", '{"key":"value","nested":{"a":1}}');
    md.toolOk("my_tool", "0.50s", '{"result":"ok"}');
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    // Should have indented JSON
    expect(content).toContain('"key": "value"');
    expect(content).toContain('"result": "ok"');
  });

  it("logs tool errors", async () => {
    const md = new MarkdownLogger(dir);
    md.toolErr("bad_tool", "Something went wrong");
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain("ERROR");
    expect(content).toContain("Something went wrong");
  });

  it("logs batch completion", async () => {
    const md = new MarkdownLogger(dir);
    md.batchDone(3, "2.10s");
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain("3 tools in 2.10s");
  });

  it("logs max iterations", async () => {
    const md = new MarkdownLogger(dir);
    md.maxIter(20);
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    expect(content).toContain("STOPPED");
    expect(content).toContain("20");
  });

  it("flush guarantees all content is on disk", async () => {
    const md = new MarkdownLogger(dir);
    // Rapid-fire many writes
    for (let i = 0; i < 50; i++) {
      md.step(i, 50, "gpt-4.1", i);
    }
    await md.flush();

    const content = await readFile(md.filePath, "utf-8");
    for (let i = 0; i < 50; i++) {
      expect(content).toContain(`Step ${i}/50`);
    }
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
