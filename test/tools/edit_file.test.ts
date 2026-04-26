import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { createHash } from "crypto";
import type { ToolResult } from "../../src/types/tool-result.ts";
import { createBunFileService, _setFilesForTest } from "../../src/infra/file.ts";
import edit_file from "../../src/tools/edit_file.ts";

let tmpDir: string;
let restore: () => void;
const testFile = () => join(tmpDir, "target.txt");

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "edit_file_test_"));
  const svc = createBunFileService([tmpDir], [tmpDir]);
  restore = _setFilesForTest(svc);
});

afterAll(async () => {
  restore();
  await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await Bun.write(testFile(), "foo bar baz\nfoo second\nhello world\n");
});

describe("edit_file tool", () => {
  it("replaces a single unique occurrence", async () => {
    await Bun.write(testFile(), "alpha beta gamma\n");
    const result = await edit_file.handler({
      file_path: testFile(),
      old_string: "beta",
      new_string: "BETA",
      replace_all: false,
      checksum: "",
      dry_run: false,
    });
    expect(getText(result)).toContain("replaced 1 occurrence");
    const content = await Bun.file(testFile()).text();
    expect(content).toBe("alpha BETA gamma\n");
  });

  it("rejects when old_string appears multiple times and replace_all is false", async () => {
    await expect(edit_file.handler({
      file_path: testFile(),
      old_string: "foo",
      new_string: "FOO",
      replace_all: false,
      checksum: "",
      dry_run: false,
    })).rejects.toThrow("found 2 times");
  });

  it("replaces all occurrences when replace_all is true", async () => {
    const result = await edit_file.handler({
      file_path: testFile(),
      old_string: "foo",
      new_string: "FOO",
      replace_all: true,
      checksum: "",
      dry_run: false,
    });
    expect(getText(result)).toContain("replaced 2 occurrence");
    const content = await Bun.file(testFile()).text();
    expect(content).toContain("FOO bar baz");
    expect(content).toContain("FOO second");
    expect(content).not.toContain("foo");
  });

  it("rejects when old_string is not found", async () => {
    await expect(edit_file.handler({
      file_path: testFile(),
      old_string: "nonexistent",
      new_string: "x",
      replace_all: false,
      checksum: "",
      dry_run: false,
    })).rejects.toThrow("not found");
  });

  it("succeeds with correct checksum", async () => {
    const content = "foo bar baz\nfoo second\nhello world\n";
    const checksum = md5(content);
    const result = await edit_file.handler({
      file_path: testFile(),
      old_string: "hello world",
      new_string: "HELLO WORLD",
      replace_all: false,
      checksum,
      dry_run: false,
    });
    expect(getText(result)).toContain("replaced 1");
  });

  it("rejects with incorrect checksum", async () => {
    await expect(edit_file.handler({
      file_path: testFile(),
      old_string: "hello world",
      new_string: "HELLO WORLD",
      replace_all: false,
      checksum: "deadbeef",
      dry_run: false,
    })).rejects.toThrow("File changed since last read");
  });

  it("skips checksum check when empty string", async () => {
    const result = await edit_file.handler({
      file_path: testFile(),
      old_string: "hello world",
      new_string: "HELLO WORLD",
      replace_all: false,
      checksum: "",
      dry_run: false,
    });
    expect(getText(result)).toContain("replaced 1");
  });

  it("returns new checksum after edit", async () => {
    const result = await edit_file.handler({
      file_path: testFile(),
      old_string: "hello world",
      new_string: "HELLO WORLD",
      replace_all: false,
      checksum: "",
      dry_run: false,
    });
    expect(getText(result)).toContain("Checksum:");
    const newContent = await Bun.file(testFile()).text();
    const expectedHash = md5(newContent);
    expect(getText(result)).toContain(expectedHash);
  });

  it("dry_run returns diff without modifying file", async () => {
    const originalContent = await Bun.file(testFile()).text();
    const result = await edit_file.handler({
      file_path: testFile(),
      old_string: "hello world",
      new_string: "HELLO WORLD",
      replace_all: false,
      checksum: "",
      dry_run: true,
    });
    expect(getText(result)).toContain("-hello world");
    expect(getText(result)).toContain("+HELLO WORLD");
    const afterContent = await Bun.file(testFile()).text();
    expect(afterContent).toBe(originalContent);
  });

  it("rejects old_string === new_string", async () => {
    await expect(edit_file.handler({
      file_path: testFile(),
      old_string: "foo",
      new_string: "foo",
      replace_all: false,
      checksum: "",
      dry_run: false,
    })).rejects.toThrow("must be different");
  });

  it("rejects empty old_string", async () => {
    await expect(edit_file.handler({
      file_path: testFile(),
      old_string: "",
      new_string: "x",
      replace_all: false,
      checksum: "",
      dry_run: false,
    })).rejects.toThrow("non-empty string");
  });

  it("rejects path outside sandbox", async () => {
    await expect(edit_file.handler({
      file_path: "/etc/passwd",
      old_string: "root",
      new_string: "x",
      replace_all: false,
      checksum: "",
      dry_run: false,
    })).rejects.toThrow("Access denied");
  });

  it("rejects prototype pollution keys", async () => {
    const args = Object.create(null);
    args.__proto__ = "x";
    args.file_path = testFile();
    args.old_string = "foo";
    args.new_string = "bar";
    args.replace_all = false;
    args.checksum = "";
    args.dry_run = false;
    await expect(edit_file.handler(args)).rejects.toThrow("Forbidden key");
  });
});
