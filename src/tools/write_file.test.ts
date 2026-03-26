import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import type { Document } from "../types/document.ts";
import { createBunFileService, _setFilesForTest } from "../infra/file.ts";
import write_file from "./write_file.ts";

let tmpDir: string;
let restore: () => void;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "write_file_test_"));
  const svc = createBunFileService([tmpDir], [tmpDir]);
  restore = _setFilesForTest(svc);
});

afterAll(async () => {
  restore();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("write_file tool", () => {
  it("creates a new file with correct content", async () => {
    const filePath = join(tmpDir, "new.txt");
    const result = await write_file.handler({ file_path: filePath, content: "hello world" }) as Document;
    expect(result.text).toContain("Wrote");
    expect(result.text).toContain("bytes");
    const actual = await Bun.file(filePath).text();
    expect(actual).toBe("hello world");
  });

  it("auto-creates parent directories", async () => {
    const filePath = join(tmpDir, "a", "b", "c", "deep.txt");
    const result = await write_file.handler({ file_path: filePath, content: "deep" }) as Document;
    expect(result.text).toContain("Wrote");
    const actual = await Bun.file(filePath).text();
    expect(actual).toBe("deep");
  });

  it("overwrites existing file", async () => {
    const filePath = join(tmpDir, "overwrite.txt");
    await Bun.write(filePath, "old");
    await write_file.handler({ file_path: filePath, content: "new" });
    const actual = await Bun.file(filePath).text();
    expect(actual).toBe("new");
  });

  it("reports correct byte count for unicode", async () => {
    const filePath = join(tmpDir, "unicode.txt");
    const result = await write_file.handler({ file_path: filePath, content: "cześć" }) as Document;
    // "cześć" is 7 bytes in UTF-8
    expect(result.text).toContain("7 bytes");
  });

  it("rejects empty file_path", async () => {
    await expect(write_file.handler({ file_path: "", content: "x" })).rejects.toThrow("non-empty string");
  });

  it("rejects file_path exceeding max length", async () => {
    await expect(write_file.handler({ file_path: "a".repeat(1025), content: "x" })).rejects.toThrow("max length");
  });

  it("rejects write outside sandbox", async () => {
    await expect(write_file.handler({ file_path: "/tmp/evil.txt", content: "x" })).rejects.toThrow("Access denied");
  });

  it("rejects prototype pollution keys", async () => {
    const args = Object.create(null);
    args.__proto__ = "x";
    args.file_path = join(tmpDir, "f.txt");
    args.content = "x";
    await expect(write_file.handler(args)).rejects.toThrow("Forbidden key");
  });

  it("includes hint", async () => {
    const filePath = join(tmpDir, "hint.txt");
    const result = await write_file.handler({ file_path: filePath, content: "x" }) as Document;
    expect(result.text).toContain("Note:");
  });
});
