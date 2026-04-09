import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import * as fs from "./fs.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fs.ts pure functions", () => {
  it("write and readText round-trip", async () => {
    const p = join(dir, "test.txt");
    await fs.write(p, "hello world");
    const content = await fs.readText(p);
    expect(content).toBe("hello world");
  });

  it("readJson parses JSON files", async () => {
    const p = join(dir, "data.json");
    await fs.write(p, JSON.stringify({ key: "value" }));
    const data = await fs.readJson<{ key: string }>(p);
    expect(data.key).toBe("value");
  });

  it("readBinary returns Buffer", async () => {
    const p = join(dir, "bin.txt");
    await fs.write(p, "binary");
    const buf = await fs.readBinary(p);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString()).toBe("binary");
  });

  it("exists returns true for existing file", async () => {
    const p = join(dir, "exists.txt");
    await fs.write(p, "x");
    expect(await fs.exists(p)).toBe(true);
  });

  it("exists returns false for missing file", async () => {
    expect(await fs.exists(join(dir, "nope.txt"))).toBe(false);
  });

  it("fsStat returns file info", async () => {
    const p = join(dir, "stat.txt");
    await fs.write(p, "hello");
    const s = await fs.fsStat(p);
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.size).toBe(5);
  });

  it("fsMkdir creates directories recursively", async () => {
    const sub = join(dir, "a", "b", "c");
    await fs.fsMkdir(sub);
    const s = await fs.fsStat(sub);
    expect(s.isDirectory).toBe(true);
  });

  it("fsReaddir lists directory contents", async () => {
    const entries = await fs.fsReaddir(dir);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("append adds data to existing file", async () => {
    const p = join(dir, "append.txt");
    await fs.write(p, "line1\n");
    await fs.append(p, "line2\n");
    const content = await fs.readText(p);
    expect(content).toBe("line1\nline2\n");
  });

  it("fsUnlink removes a file", async () => {
    const p = join(dir, "unlink.txt");
    await fs.write(p, "delete me");
    await fs.fsUnlink(p);
    expect(await fs.exists(p)).toBe(false);
  });

  it("fsRename moves a file", async () => {
    const from = join(dir, "rename-from.txt");
    const to = join(dir, "rename-to.txt");
    await fs.write(from, "move me");
    await fs.fsRename(from, to);
    expect(await fs.exists(from)).toBe(false);
    expect(await fs.readText(to)).toBe("move me");
  });

  it("checkFileSize passes for small file", () => {
    expect(() => fs.checkFileSize({ isFile: true, isDirectory: false, size: 100 }, 1024, "test")).not.toThrow();
  });

  it("checkFileSize throws for oversized file", () => {
    expect(() => fs.checkFileSize({ isFile: true, isDirectory: false, size: 2048 }, 1024, "test")).toThrow("exceeds limit");
  });
});
