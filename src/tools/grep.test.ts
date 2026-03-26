import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import type { Document } from "../types/document.ts";
import { createBunFileService, _setFilesForTest } from "../infra/file.ts";
import grep from "./grep.ts";

let tmpDir: string;
let restore: () => void;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grep_test_"));
  const svc = createBunFileService([tmpDir], [tmpDir]);
  restore = _setFilesForTest(svc);

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
    }) as Document;
    expect(result.text).toContain("code.ts:1: const foo = 1;");
    expect(result.text).not.toContain("FOO"); // case sensitive
  });

  it("supports case-insensitive search", async () => {
    const result = await grep.handler({
      pattern: "hello",
      path: tmpDir,
      include: "*.md",
      case_insensitive: true,
    }) as Document;
    expect(result.text).toContain("Hello World");
    expect(result.text).toContain("hello again");
    expect(result.text).toContain("HELLO CAPS");
  });

  it("respects include filter", async () => {
    const result = await grep.handler({
      pattern: "hello",
      path: tmpDir,
      include: "*.json",
      case_insensitive: false,
    }) as Document;
    expect(result.text).toContain("data.json");
    expect(result.text).not.toContain("readme.md");
  });

  it("caps at 20 matches per file", async () => {
    const result = await grep.handler({
      pattern: "match_",
      path: tmpDir,
      include: "many.txt",
      case_insensitive: false,
    }) as Document;
    // File has 50 matches but should be capped at 20
    const matchLines = result.text.split("\n").filter(l => l.includes("many.txt:"));
    expect(matchLines.length).toBe(20);
  });

  it("shows match count summary", async () => {
    const result = await grep.handler({
      pattern: "const",
      path: tmpDir,
      include: "*.ts",
      case_insensitive: false,
    }) as Document;
    expect(result.text).toContain("Matches:");
    expect(result.text).toContain("line(s)");
  });

  it("reports no matches gracefully", async () => {
    const result = await grep.handler({
      pattern: "nonexistent_pattern_xyz",
      path: tmpDir,
      include: "*",
      case_insensitive: false,
    }) as Document;
    expect(result.text).toContain("No matches");
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
    }) as Document;
    expect(result.text).toContain("Note:");
  });
});
