import { readdir, stat, mkdir, appendFile } from "fs/promises";
import { resolve } from "path";
import type { FileProvider, FileStat } from "../types/file.ts";
import { config } from "../config/index.ts";

// Mutable copies of config paths — tests push/splice these for temp dir access
export const _testReadPaths: string[] = [...config.sandbox.allowedReadPaths];
export const _testWritePaths: string[] = [...config.sandbox.allowedWritePaths];

function assertPathAllowed(
  targetPath: string,
  allowedDirs: string[],
  operation: "read" | "write",
): void {
  const resolved = resolve(targetPath);
  const allowed = allowedDirs.some((dir) => {
    const resolvedDir = resolve(dir);
    return resolved === resolvedDir || resolved.startsWith(resolvedDir + "/");
  });
  if (!allowed) {
    throw new Error(
      `Access denied: cannot ${operation} "${resolved}". Allowed ${operation} directories: [${allowedDirs.map((d) => resolve(d)).join(", ")}]`,
    );
  }
}

export function createBunFileService(
  readPaths: string[] = _testReadPaths,
  writePaths: string[] = _testWritePaths,
): FileProvider {
  return {
    async readText(path: string): Promise<string> {
      assertPathAllowed(path, readPaths, "read");
      return Bun.file(path).text();
    },

    async readBinary(path: string): Promise<Buffer> {
      assertPathAllowed(path, readPaths, "read");
      const arrayBuf = await Bun.file(path).arrayBuffer();
      return Buffer.from(arrayBuf);
    },

    async readJson<T = unknown>(path: string): Promise<T> {
      assertPathAllowed(path, readPaths, "read");
      return Bun.file(path).json() as Promise<T>;
    },

    async write(path: string, data: string | Response): Promise<void> {
      assertPathAllowed(path, writePaths, "write");
      if (data instanceof Response) {
        await Bun.write(path, data);
      } else {
        await Bun.write(path, data);
      }
    },

    async append(path: string, data: string): Promise<void> {
      assertPathAllowed(path, writePaths, "write");
      await appendFile(path, data);
    },

    async readdir(path: string): Promise<string[]> {
      assertPathAllowed(path, readPaths, "read");
      return readdir(path);
    },

    async stat(path: string): Promise<FileStat> {
      assertPathAllowed(path, readPaths, "read");
      const s = await stat(path);
      return { isFile: s.isFile(), isDirectory: s.isDirectory() };
    },

    async mkdir(path: string): Promise<void> {
      assertPathAllowed(path, writePaths, "write");
      await mkdir(path, { recursive: true });
    },
  };
}

export const files: FileProvider = createBunFileService();
