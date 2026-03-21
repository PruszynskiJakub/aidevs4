import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  safeParse,
  safeFilename,
  validateKeys,
  assertMaxLength,
  assertNumericBounds,
  checkFileSize,
  resolveInput,
} from "./parse.ts";
import { _testReadPaths } from "../services/common/file.ts";

// --------------- safeParse ---------------

describe("safeParse", () => {
  it("parses valid JSON", () => {
    expect(safeParse<Record<string, number>>('{"a":1}', "test")).toEqual({ a: 1 });
  });

  it("parses valid JSON array", () => {
    expect(safeParse<number[]>("[1,2,3]", "arr")).toEqual([1, 2, 3]);
  });

  it("parses valid JSON string", () => {
    expect(safeParse<string>('"hello"', "str")).toBe("hello");
  });

  it("throws labelled error on invalid JSON", () => {
    expect(() => safeParse("not-json", "field_map")).toThrow("Invalid JSON for field_map");
  });

  it("does not echo raw input in error message", () => {
    try {
      safeParse("secret-data-leak", "myfield");
    } catch (e: any) {
      expect(e.message).not.toContain("secret-data-leak");
      expect(e.message).toContain("myfield");
    }
  });

  it("throws on empty string", () => {
    expect(() => safeParse("", "empty")).toThrow("Invalid JSON for empty");
  });
});

// --------------- safeFilename ---------------

describe("safeFilename", () => {
  it("accepts clean filenames", () => {
    expect(safeFilename("data.csv")).toBe("data.csv");
    expect(safeFilename("my-file_v2.json")).toBe("my-file_v2.json");
    expect(safeFilename("REPORT.TXT")).toBe("REPORT.TXT");
  });

  it("rejects empty string", () => {
    expect(() => safeFilename("")).toThrow("must not be empty");
  });

  it("rejects path traversal with ../", () => {
    expect(() => safeFilename("../etc/passwd")).toThrow();
  });

  it("rejects path traversal with ..\\", () => {
    expect(() => safeFilename("..\\etc\\passwd")).toThrow();
  });

  it("rejects forward slash", () => {
    expect(() => safeFilename("path/file.txt")).toThrow("path separators");
  });

  it("rejects backslash", () => {
    expect(() => safeFilename("path\\file.txt")).toThrow("path separators");
  });

  it("rejects hidden files", () => {
    expect(() => safeFilename(".env")).toThrow("hidden file");
    expect(() => safeFilename(".htaccess")).toThrow("hidden file");
  });

  it("rejects spaces in filename", () => {
    expect(() => safeFilename("foo bar.txt")).toThrow("invalid characters");
  });

  it("rejects special characters", () => {
    expect(() => safeFilename("file;rm -rf.txt")).toThrow("invalid characters");
    expect(() => safeFilename("file$(cmd).txt")).toThrow("invalid characters");
  });

  it("rejects standalone ..", () => {
    expect(() => safeFilename("..")).toThrow();
  });
});

// --------------- validateKeys ---------------

describe("validateKeys", () => {
  it("accepts normal keys", () => {
    expect(() => validateKeys({ name: "a", age: 1 })).not.toThrow();
  });

  it("accepts empty object", () => {
    expect(() => validateKeys({})).not.toThrow();
  });

  it("rejects __proto__", () => {
    const obj = Object.fromEntries([["__proto__", "x"]]);
    expect(() => validateKeys(obj)).toThrow('Forbidden key: "__proto__"');
  });

  it("rejects constructor", () => {
    // Use Object.fromEntries to actually set 'constructor' as own key
    const obj = Object.fromEntries([["constructor", "x"], ["ok", 1]]);
    expect(() => validateKeys(obj)).toThrow('Forbidden key: "constructor"');
  });

  it("rejects prototype", () => {
    const obj = Object.fromEntries([["prototype", "x"]]);
    expect(() => validateKeys(obj)).toThrow('Forbidden key: "prototype"');
  });
});

// --------------- assertMaxLength ---------------

describe("assertMaxLength", () => {
  it("passes for string within limit", () => {
    expect(() => assertMaxLength("hello", "field", 10)).not.toThrow();
  });

  it("passes for string at exactly the limit", () => {
    expect(() => assertMaxLength("12345", "field", 5)).not.toThrow();
  });

  it("throws for string over limit", () => {
    expect(() => assertMaxLength("123456", "myfield", 5)).toThrow(
      "myfield exceeds max length of 5 characters",
    );
  });
});

// --------------- assertNumericBounds ---------------

describe("assertNumericBounds", () => {
  it("passes for value within bounds", () => {
    expect(() => assertNumericBounds(45, "lat", -90, 90)).not.toThrow();
  });

  it("passes for value at min boundary", () => {
    expect(() => assertNumericBounds(-90, "lat", -90, 90)).not.toThrow();
  });

  it("passes for value at max boundary", () => {
    expect(() => assertNumericBounds(90, "lat", -90, 90)).not.toThrow();
  });

  it("rejects NaN", () => {
    expect(() => assertNumericBounds(NaN, "lat", -90, 90)).toThrow("finite number");
  });

  it("rejects Infinity", () => {
    expect(() => assertNumericBounds(Infinity, "lon", -180, 180)).toThrow("finite number");
  });

  it("rejects -Infinity", () => {
    expect(() => assertNumericBounds(-Infinity, "lon", -180, 180)).toThrow("finite number");
  });

  it("rejects value below min", () => {
    expect(() => assertNumericBounds(-91, "lat", -90, 90)).toThrow("between -90 and 90");
  });

  it("rejects value above max", () => {
    expect(() => assertNumericBounds(91, "lat", -90, 90)).toThrow("between -90 and 90");
  });
});

// --------------- checkFileSize ---------------

describe("checkFileSize", () => {
  it("passes for small file", async () => {
    let tmp = await mkdtemp(join(tmpdir(), "parse-test-"));
    _testReadPaths.push(tmp);
    try {
      const p = join(tmp, "small.txt");
      await Bun.write(p, "hello");
      await expect(checkFileSize(p, 1024)).resolves.toBeUndefined();
    } finally {
      _testReadPaths.splice(_testReadPaths.indexOf(tmp), 1);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects file over limit", async () => {
    let tmp = await mkdtemp(join(tmpdir(), "parse-test-"));
    _testReadPaths.push(tmp);
    try {
      const p = join(tmp, "big.txt");
      await Bun.write(p, "x".repeat(2048));
      await expect(checkFileSize(p, 1024)).rejects.toThrow("exceeds limit");
    } finally {
      _testReadPaths.splice(_testReadPaths.indexOf(tmp), 1);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("throws on nonexistent file", async () => {
    let tmp = await mkdtemp(join(tmpdir(), "parse-test-"));
    _testReadPaths.push(tmp);
    try {
      await expect(checkFileSize(join(tmp, "nonexistent-file-xyz.txt"))).rejects.toThrow();
    } finally {
      _testReadPaths.splice(_testReadPaths.indexOf(tmp), 1);
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// --------------- resolveInput ---------------

describe("resolveInput", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "resolve-input-test-"));
    _testReadPaths.push(tmp);
  });

  afterAll(async () => {
    _testReadPaths.splice(_testReadPaths.indexOf(tmp), 1);
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads and parses a JSON file", async () => {
    const p = join(tmp, "data.json");
    await Bun.write(p, JSON.stringify({ city: "Krakow" }));
    const result = await resolveInput(p, "test");
    expect(result).toEqual({ city: "Krakow" });
  });

  it("parses inline JSON object", async () => {
    const result = await resolveInput('{"city":"Krakow"}', "test");
    expect(result).toEqual({ city: "Krakow" });
  });

  it("parses inline JSON array", async () => {
    const result = await resolveInput("[1,2,3]", "test");
    expect(result).toEqual([1, 2, 3]);
  });

  it("parses inline JSON number", async () => {
    const result = await resolveInput("42", "test");
    expect(result).toBe(42);
  });

  it("returns raw string for non-JSON, non-file input", async () => {
    const result = await resolveInput("KRAKOW", "test");
    expect(result).toBe("KRAKOW");
  });

  it("returns raw string for invalid JSON that is not a file", async () => {
    const result = await resolveInput("not/a/file/{bad", "test");
    expect(result).toBe("not/a/file/{bad");
  });
});
