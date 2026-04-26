import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createBunFileService, FileSizeLimitError } from "../../src/infra/file.ts";

let allowedDir: string;
let siblingDir: string;
let outsideDir: string;

beforeAll(async () => {
  // Create dirs with a shared prefix to test boundary cases
  allowedDir = await mkdtemp(join(tmpdir(), "sandbox-allowed-"));
  siblingDir = allowedDir + "_sibling";
  outsideDir = await mkdtemp(join(tmpdir(), "sandbox-outside-"));

  await Bun.write(join(allowedDir, "hello.txt"), "hello");
  await Bun.write(join(outsideDir, "secret.txt"), "secret");

  // Create sibling dir with a file
  const { mkdir } = await import("fs/promises");
  await mkdir(siblingDir, { recursive: true });
  await writeFile(join(siblingDir, "trick.txt"), "trick");
});

afterAll(async () => {
  await rm(allowedDir, { recursive: true, force: true });
  await rm(siblingDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("File service sandbox", () => {
  describe("read operations", () => {
    it("allows reading a file inside allowed read dir", async () => {
      const svc = createBunFileService([allowedDir], []);
      const content = await svc.readText(join(allowedDir, "hello.txt"));
      expect(content).toBe("hello");
    });

    it("allows reading the allowed directory itself (readdir)", async () => {
      const svc = createBunFileService([allowedDir], []);
      const entries = await svc.readdir(allowedDir);
      expect(entries).toContain("hello.txt");
    });

    it("allows stat on a file inside allowed read dir", async () => {
      const svc = createBunFileService([allowedDir], []);
      const s = await svc.stat(join(allowedDir, "hello.txt"));
      expect(s.isFile).toBe(true);
    });

    it("denies reading a file outside allowed dirs", async () => {
      const svc = createBunFileService([allowedDir], []);
      expect(svc.readText("/etc/passwd")).rejects.toThrow(
        /Access denied: cannot read/,
      );
    });

    it("denies readJson outside allowed dirs", async () => {
      const svc = createBunFileService([allowedDir], []);
      expect(svc.readJson(join(outsideDir, "secret.txt"))).rejects.toThrow(
        /Access denied: cannot read/,
      );
    });

    it("denies ../traversal that escapes allowed dir", async () => {
      const svc = createBunFileService([allowedDir], []);
      const traversal = join(allowedDir, "..", "..", "etc", "passwd");
      expect(svc.readText(traversal)).rejects.toThrow(
        /Access denied: cannot read/,
      );
    });

    it("denies sibling dir with matching prefix", async () => {
      const svc = createBunFileService([allowedDir], []);
      expect(
        svc.readText(join(siblingDir, "trick.txt")),
      ).rejects.toThrow(/Access denied: cannot read/);
    });
  });

  describe("write operations", () => {
    it("allows writing a file inside allowed write dir", async () => {
      const svc = createBunFileService([], [allowedDir]);
      await svc.write(join(allowedDir, "out.txt"), "data");
      const content = await Bun.file(join(allowedDir, "out.txt")).text();
      expect(content).toBe("data");
    });

    it("allows mkdir inside allowed write dir", async () => {
      const svc = createBunFileService([], [allowedDir]);
      const sub = join(allowedDir, "subdir");
      await svc.mkdir(sub);
      const { stat } = await import("fs/promises");
      const s = await stat(sub);
      expect(s.isDirectory()).toBe(true);
    });

    it("denies writing outside allowed dirs", async () => {
      const svc = createBunFileService([], [allowedDir]);
      expect(
        svc.write(join(outsideDir, "evil.txt"), "bad"),
      ).rejects.toThrow(/Access denied: cannot write/);
    });

    it("denies mkdir outside allowed dirs", async () => {
      const svc = createBunFileService([], [allowedDir]);
      expect(
        svc.mkdir(join(outsideDir, "evil-dir")),
      ).rejects.toThrow(/Access denied: cannot write/);
    });
  });

  describe("error messages", () => {
    it("includes the denied path and allowed directories", async () => {
      const svc = createBunFileService([allowedDir], []);
      try {
        await svc.readText("/etc/passwd");
        expect(true).toBe(false); // should not reach
      } catch (e: any) {
        expect(e.message).toContain("/etc/passwd");
        expect(e.message).toContain("Allowed read directories:");
        expect(e.message).toContain(allowedDir);
      }
    });
  });

  describe("checkFileSize", () => {
    it("passes for small file", async () => {
      const svc = createBunFileService([allowedDir], []);
      await expect(svc.checkFileSize(join(allowedDir, "hello.txt"), 1024)).resolves.toBeUndefined();
    });

    it("rejects file over limit", async () => {
      const svc = createBunFileService([allowedDir], [allowedDir]);
      const p = join(allowedDir, "big.txt");
      await Bun.write(p, "x".repeat(2048));
      await expect(svc.checkFileSize(p, 1024)).rejects.toThrow("exceeds limit");
    });
  });

  describe("resolveInput", () => {
    it("reads and parses a JSON file", async () => {
      const svc = createBunFileService([allowedDir], [allowedDir]);
      const p = join(allowedDir, "data.json");
      await Bun.write(p, JSON.stringify({ city: "Krakow" }));
      const result = await svc.resolveInput(p, "test");
      expect(result).toEqual({ city: "Krakow" });
    });

    it("parses inline JSON object", async () => {
      const svc = createBunFileService([allowedDir], []);
      const result = await svc.resolveInput('{"city":"Krakow"}', "test");
      expect(result).toEqual({ city: "Krakow" });
    });

    it("returns raw string for non-JSON, non-file input", async () => {
      const svc = createBunFileService([allowedDir], []);
      const result = await svc.resolveInput("KRAKOW", "test");
      expect(result).toBe("KRAKOW");
    });
  });
});
