import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { createHash } from "crypto";
import type { ToolResult } from "../types/tool-result.ts";
import type { FileProvider } from "../types/file.ts";
import { createSandbox, _setSandboxForTest } from "../infra/sandbox.ts";
import read_file from "./read_file.ts";

let tmpDir: string;
let restore: () => void;

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "read_file_test_"));
  const svc = createSandbox({ readPaths: [tmpDir], writePaths: [tmpDir], blockedWritePaths: [] });
  restore = _setSandboxForTest(svc);

  // Create test files
  await Bun.write(join(tmpDir, "hello.txt"), "line1\nline2\nline3\nline4\nline5\n");
  await Bun.write(join(tmpDir, "twenty.txt"), Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n"));
  await Bun.write(join(tmpDir, "empty.txt"), "");
});

afterAll(async () => {
  restore();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("read_file tool", () => {
  it("reads a file with line numbers in cat -n format", async () => {
    const result = await read_file.handler({ file_path: join(tmpDir, "hello.txt") });
    expect(getText(result)).toContain("  1\tline1");
    expect(getText(result)).toContain("  2\tline2");
  });

  it("returns md5 checksum", async () => {
    const content = "line1\nline2\nline3\nline4\nline5\n";
    const expected = createHash("md5").update(content).digest("hex");
    const result = await read_file.handler({ file_path: join(tmpDir, "hello.txt") });
    expect(getText(result)).toContain(`Checksum: ${expected}`);
  });

  it("supports offset and limit pagination", async () => {
    const result = await read_file.handler({
      file_path: join(tmpDir, "twenty.txt"),
      offset: 5,
      limit: 3,
    });
    const t = getText(result);
    expect(t).toContain("  5\tline5");
    expect(t).toContain("  6\tline6");
    expect(t).toContain("  7\tline7");
    expect(t).not.toContain("  4\t");
    expect(t).not.toContain("  8\t");
  });

  it("handles offset beyond total lines", async () => {
    const result = await read_file.handler({
      file_path: join(tmpDir, "hello.txt"),
      offset: 999,
    });
    expect(getText(result)).toContain("Nothing to show");
    expect(getText(result)).toContain("Checksum:");
  });

  it("includes line count in output", async () => {
    const result = await read_file.handler({ file_path: join(tmpDir, "twenty.txt") });
    expect(getText(result)).toContain("Lines: 20");
  });

  it("rejects empty file_path", async () => {
    await expect(read_file.handler({ file_path: "" })).rejects.toThrow("non-empty string");
  });

  it("rejects file_path exceeding max length", async () => {
    await expect(read_file.handler({ file_path: "a".repeat(1025) })).rejects.toThrow("max length");
  });

  it("rejects path outside sandbox", async () => {
    await expect(read_file.handler({ file_path: "/etc/passwd" })).rejects.toThrow("Access denied");
  });

  it("rejects path traversal", async () => {
    await expect(read_file.handler({ file_path: join(tmpDir, "../../etc/passwd") })).rejects.toThrow("Access denied");
  });

  it("rejects prototype pollution keys", async () => {
    const args = Object.create(null);
    args.__proto__ = "x";
    args.file_path = join(tmpDir, "hello.txt");
    await expect(read_file.handler(args)).rejects.toThrow("Forbidden key");
  });

  it("rejects negative offset", async () => {
    await expect(read_file.handler({ file_path: join(tmpDir, "hello.txt"), offset: -1 })).rejects.toThrow("offset must be >= 1");
  });

  it("includes hint about adjusting offset/limit", async () => {
    const result = await read_file.handler({ file_path: join(tmpDir, "hello.txt") });
    expect(getText(result)).toContain("Note:");
  });
});
