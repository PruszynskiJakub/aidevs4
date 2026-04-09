import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import type { ToolResult } from "../types/tool-result.ts";
import { createSandbox, _setSandboxForTest } from "../infra/sandbox.ts";
import grep from "./grep.ts";

let tmpDir: string;
let restore: () => void;

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grep_test_"));
  const svc = createSandbox({ readPaths: [tmpDir], writePaths: [tmpDir], blockedWritePaths: [] });
  restore = _setSandboxForTest(svc);

  await Bun.write(join(tmpDir, "code.ts"), "const foo = 1;\nconst bar = 2;\nconst FOO = 3;\n");
  await Bun.write(join(tmpDir, "data.json"), '{"hello": "world"}\n');
  await Bun.write(join(tmpDir, "readme.md"), "Hello World\nhello again\nHELLO CAPS\n");

  // Create file with many matches for per-file cap test
  const manyLines = Array.from({ length: 50 }, (_, i) => `match_${i}`).join("\n");
  await Bun.write(join(tmpDir, "many.txt"), manyLines);
});

afterAll(async () => {
  restore();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("grep tool", () => {
  it("finds matches in file:line:content format", async () => {
    const result = await grep.handler({
      pattern: "foo",
      path: tmpDir,
      include: "*.ts",
      case_insensitive: false,
    });
    expect(getText(result)).toContain("code.ts:1: const foo = 1;");
    expect(getText(result)).not.toContain("FOO"); // case sensitive
  });

  it("supports case-insensitive search", async () => {
    const result = await grep.handler({
      pattern: "hello",
      path: tmpDir,
      include: "*.md",
      case_insensitive: true,
    });
    expect(getText(result)).toContain("Hello World");
    expect(getText(result)).toContain("hello again");
    expect(getText(result)).toContain("HELLO CAPS");
  });

  it("respects include filter", async () => {
    const result = await grep.handler({
      pattern: "hello",
      path: tmpDir,
      include: "*.json",
      case_insensitive: false,
    });
    expect(getText(result)).toContain("data.json");
    expect(getText(result)).not.toContain("readme.md");
  });

  it("caps at 20 matches per file", async () => {
    const result = await grep.handler({
      pattern: "match_",
      path: tmpDir,
      include: "many.txt",
      case_insensitive: false,
    });
    const matchLines = getText(result).split("\n").filter(l => l.includes("many.txt:"));
    expect(matchLines.length).toBe(20);
  });

  it("shows match count summary", async () => {
    const result = await grep.handler({
      pattern: "const",
      path: tmpDir,
      include: "*.ts",
      case_insensitive: false,
    });
    expect(getText(result)).toContain("Matches:");
    expect(getText(result)).toContain("line(s)");
  });

  it("reports no matches gracefully", async () => {
    const result = await grep.handler({
      pattern: "nonexistent_pattern_xyz",
      path: tmpDir,
      include: "*",
      case_insensitive: false,
    });
    expect(getText(result)).toContain("No matches");
  });

  it("rejects invalid regex", async () => {
    await expect(grep.handler({
      pattern: "[invalid",
      path: tmpDir,
      include: "*",
      case_insensitive: false,
    })).rejects.toThrow("Invalid regex");
  });

  it("rejects empty pattern", async () => {
    await expect(grep.handler({
      pattern: "",
      path: tmpDir,
      include: "*",
      case_insensitive: false,
    })).rejects.toThrow("non-empty string");
  });

  it("rejects path outside sandbox", async () => {
    await expect(grep.handler({
      pattern: "test",
      path: "/etc",
      include: "*",
      case_insensitive: false,
    })).rejects.toThrow("Access denied");
  });

  it("rejects prototype pollution keys", async () => {
    const args = Object.create(null);
    args.__proto__ = "x";
    args.pattern = "test";
    args.path = tmpDir;
    args.include = "*";
    args.case_insensitive = false;
    await expect(grep.handler(args)).rejects.toThrow("Forbidden key");
  });

  it("includes hint", async () => {
    const result = await grep.handler({
      pattern: "foo",
      path: tmpDir,
      include: "*",
      case_insensitive: false,
    });
    expect(getText(result)).toContain("Note:");
  });
});
