import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import type { Document } from "../types/document.ts";
import { createBunFileService, _setFilesForTest } from "../infra/file.ts";
import glob from "./glob.ts";

let tmpDir: string;
let restore: () => void;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "glob_test_"));
  const svc = createBunFileService([tmpDir], [tmpDir]);
  restore = _setFilesForTest(svc);

  // Create test files
  await Bun.write(join(tmpDir, "a.txt"), "a");
  await Bun.write(join(tmpDir, "b.txt"), "b");
  await Bun.write(join(tmpDir, "c.json"), "{}");
  await Bun.write(join(tmpDir, "sub/d.txt"), "d");
});

afterAll(async () => {
  restore();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("glob tool", () => {
  it("finds files matching a pattern", async () => {
    const result = await glob.handler({ pattern: "*.txt", path: tmpDir }) as Document;
    expect(result.text).toContain("a.txt");
    expect(result.text).toContain("b.txt");
    expect(result.text).not.toContain("c.json");
  });

  it("returns results sorted alphabetically", async () => {
    const result = await glob.handler({ pattern: "*.txt", path: tmpDir }) as Document;
    const lines = result.text.split("\n").filter(l => l.endsWith(".txt"));
    const sorted = [...lines].sort();
    expect(lines).toEqual(sorted);
  });

  it("finds files recursively with **", async () => {
    const result = await glob.handler({ pattern: "**/*.txt", path: tmpDir }) as Document;
    expect(result.text).toContain("a.txt");
    expect(result.text).toContain("d.txt");
  });

  it("shows total count", async () => {
    const result = await glob.handler({ pattern: "**/*", path: tmpDir }) as Document;
    expect(result.text).toContain("Total:");
    expect(result.text).toContain("file(s)");
  });

  it("reports no matches gracefully", async () => {
    const result = await glob.handler({ pattern: "*.xyz", path: tmpDir }) as Document;
    expect(result.text).toContain("No files matched");
  });

  it("rejects empty pattern", async () => {
    await expect(glob.handler({ pattern: "", path: tmpDir })).rejects.toThrow("non-empty string");
  });

  it("rejects empty path", async () => {
    await expect(glob.handler({ pattern: "*.txt", path: "" })).rejects.toThrow("non-empty string");
  });

  it("rejects path outside sandbox", async () => {
    await expect(glob.handler({ pattern: "*.txt", path: "/etc" })).rejects.toThrow("Access denied");
  });

  it("rejects pattern exceeding max length", async () => {
    await expect(glob.handler({ pattern: "a".repeat(513), path: tmpDir })).rejects.toThrow("max length");
  });

  it("rejects prototype pollution keys", async () => {
    const args = Object.create(null);
    args.__proto__ = "x";
    args.pattern = "*.txt";
    args.path = tmpDir;
    await expect(glob.handler(args)).rejects.toThrow("Forbidden key");
  });

  it("includes hint", async () => {
    const result = await glob.handler({ pattern: "*.txt", path: tmpDir }) as Document;
    expect(result.text).toContain("Note:");
  });
});
