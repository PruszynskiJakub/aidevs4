import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createSandbox, _setSandboxForTest } from "./sandbox.ts";

let allowedDir: string;
let siblingDir: string;
let outsideDir: string;
let blockedDir: string;

beforeAll(async () => {
  allowedDir = await mkdtemp(join(tmpdir(), "sandbox-allowed-"));
  siblingDir = allowedDir + "_sibling";
  outsideDir = await mkdtemp(join(tmpdir(), "sandbox-outside-"));
  blockedDir = join(allowedDir, "system");

  await Bun.write(join(allowedDir, "hello.txt"), "hello");
  await Bun.write(join(outsideDir, "secret.txt"), "secret");

  await mkdir(siblingDir, { recursive: true });
  await writeFile(join(siblingDir, "trick.txt"), "trick");

  await mkdir(blockedDir, { recursive: true });
  await Bun.write(join(blockedDir, "protected.txt"), "protected");
});

afterAll(async () => {
  await rm(allowedDir, { recursive: true, force: true });
  await rm(siblingDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("Sandbox", () => {
  describe("read operations", () => {
    it("allows reading a file inside allowed read dir", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [] });
      const content = await svc.readText(join(allowedDir, "hello.txt"));
      expect(content).toBe("hello");
    });

    it("allows readdir on the allowed directory itself", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [] });
      const entries = await svc.readdir(allowedDir);
      expect(entries).toContain("hello.txt");
    });

    it("allows stat on a file inside allowed read dir", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [] });
      const s = await svc.stat(join(allowedDir, "hello.txt"));
      expect(s.isFile).toBe(true);
    });

    it("denies reading a file outside allowed dirs", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [] });
      expect(svc.readText("/etc/passwd")).rejects.toThrow(
        /Access denied: cannot read/,
      );
    });

    it("denies readJson outside allowed dirs", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [] });
      expect(svc.readJson(join(outsideDir, "secret.txt"))).rejects.toThrow(
        /Access denied: cannot read/,
      );
    });

    it("denies ../traversal that escapes allowed dir", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [] });
      const traversal = join(allowedDir, "..", "..", "etc", "passwd");
      expect(svc.readText(traversal)).rejects.toThrow(
        /Access denied: cannot read/,
      );
    });

    it("denies sibling dir with matching prefix", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [] });
      expect(
        svc.readText(join(siblingDir, "trick.txt")),
      ).rejects.toThrow(/Access denied: cannot read/);
    });
  });

  describe("write operations", () => {
    it("allows writing a file inside allowed write dir", async () => {
      const svc = createSandbox({ readPaths: [], writePaths: [allowedDir], blockedWritePaths: [] });
      await svc.write(join(allowedDir, "out.txt"), "data");
      const content = await Bun.file(join(allowedDir, "out.txt")).text();
      expect(content).toBe("data");
    });

    it("allows mkdir inside allowed write dir", async () => {
      const svc = createSandbox({ readPaths: [], writePaths: [allowedDir], blockedWritePaths: [] });
      const sub = join(allowedDir, "subdir");
      await svc.mkdir(sub);
      const { stat } = await import("fs/promises");
      const s = await stat(sub);
      expect(s.isDirectory()).toBe(true);
    });

    it("denies writing outside allowed dirs", async () => {
      const svc = createSandbox({ readPaths: [], writePaths: [allowedDir], blockedWritePaths: [] });
      expect(
        svc.write(join(outsideDir, "evil.txt"), "bad"),
      ).rejects.toThrow(/Access denied: cannot write/);
    });

    it("denies mkdir outside allowed dirs", async () => {
      const svc = createSandbox({ readPaths: [], writePaths: [allowedDir], blockedWritePaths: [] });
      expect(
        svc.mkdir(join(outsideDir, "evil-dir")),
      ).rejects.toThrow(/Access denied: cannot write/);
    });
  });

  describe("blocklist enforcement", () => {
    it("denies writing to blocked (system/) directory", async () => {
      const svc = createSandbox({
        readPaths: [allowedDir],
        writePaths: [allowedDir],
        blockedWritePaths: [blockedDir],
      });
      expect(
        svc.write(join(blockedDir, "evil.txt"), "bad"),
      ).rejects.toThrow(/protected directory/);
    });

    it("denies mkdir in blocked directory", async () => {
      const svc = createSandbox({
        readPaths: [allowedDir],
        writePaths: [allowedDir],
        blockedWritePaths: [blockedDir],
      });
      expect(
        svc.mkdir(join(blockedDir, "subdir")),
      ).rejects.toThrow(/protected directory/);
    });

    it("allows writing to sibling of blocked dir (system_backup/ vs system/)", async () => {
      const systemBackup = join(allowedDir, "system_backup");
      await mkdir(systemBackup, { recursive: true });
      const svc = createSandbox({
        readPaths: [allowedDir],
        writePaths: [allowedDir],
        blockedWritePaths: [blockedDir],
      });
      await svc.write(join(systemBackup, "ok.txt"), "allowed");
      const content = await Bun.file(join(systemBackup, "ok.txt")).text();
      expect(content).toBe("allowed");
    });

    it("allows reading from blocked directory (only writes blocked)", async () => {
      const svc = createSandbox({
        readPaths: [allowedDir],
        writePaths: [allowedDir],
        blockedWritePaths: [blockedDir],
      });
      const content = await svc.readText(join(blockedDir, "protected.txt"));
      expect(content).toBe("protected");
    });
  });

  describe("unlink and rename", () => {
    it("allows unlinking inside write dir", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [allowedDir], blockedWritePaths: [] });
      const p = join(allowedDir, "to-delete.txt");
      await Bun.write(p, "temp");
      await svc.unlink(p);
      expect(await Bun.file(p).exists()).toBe(false);
    });

    it("allows renaming within write dir", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [allowedDir], blockedWritePaths: [] });
      const from = join(allowedDir, "rename-src.txt");
      const to = join(allowedDir, "rename-dst.txt");
      await Bun.write(from, "content");
      await svc.rename(from, to);
      expect(await Bun.file(to).text()).toBe("content");
      expect(await Bun.file(from).exists()).toBe(false);
    });
  });

  describe("error messages", () => {
    it("includes the denied path and allowed directories", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [] });
      try {
        await svc.readText("/etc/passwd");
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.message).toContain("/etc/passwd");
        expect(e.message).toContain("Allowed read directories:");
        expect(e.message).toContain(allowedDir);
      }
    });
  });

  describe("checkFileSize", () => {
    it("passes for small file", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [] });
      await expect(svc.checkFileSize(join(allowedDir, "hello.txt"), 1024)).resolves.toBeUndefined();
    });

    it("rejects file over limit", async () => {
      const svc = createSandbox({ readPaths: [allowedDir], writePaths: [allowedDir], blockedWritePaths: [] });
      const p = join(allowedDir, "big.txt");
      await Bun.write(p, "x".repeat(2048));
      await expect(svc.checkFileSize(p, 1024)).rejects.toThrow("exceeds limit");
    });
  });

  describe("createSandbox with custom config", () => {
    it("narrows to session-dir-only scope", async () => {
      const sessionDir = join(allowedDir, "session-only");
      await mkdir(sessionDir, { recursive: true });
      const svc = createSandbox({
        readPaths: [sessionDir],
        writePaths: [sessionDir],
        blockedWritePaths: [],
      });
      await svc.write(join(sessionDir, "data.txt"), "ok");
      expect(await svc.readText(join(sessionDir, "data.txt"))).toBe("ok");
      expect(svc.readText(join(allowedDir, "hello.txt"))).rejects.toThrow(/Access denied/);
    });
  });

  describe("_setSandboxForTest", () => {
    it("replaces singleton and restores on cleanup", async () => {
      const mock = createSandbox({ readPaths: [allowedDir], writePaths: [], blockedWritePaths: [] });
      const restore = _setSandboxForTest(mock);
      // After restore, the original singleton is back (basic smoke test)
      restore();
    });
  });
});
