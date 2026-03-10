import { readdir, stat, mkdir } from "fs/promises";
import type { FileProvider, FileStat } from "../types/file.ts";

export function createBunFileService(): FileProvider {
  return {
    async readText(path: string): Promise<string> {
      return Bun.file(path).text();
    },

    async readJson<T = unknown>(path: string): Promise<T> {
      return Bun.file(path).json() as Promise<T>;
    },

    async write(path: string, data: string | Response): Promise<void> {
      if (data instanceof Response) {
        await Bun.write(path, data);
      } else {
        await Bun.write(path, data);
      }
    },

    async readdir(path: string): Promise<string[]> {
      return readdir(path);
    },

    async stat(path: string): Promise<FileStat> {
      const s = await stat(path);
      return { isFile: s.isFile(), isDirectory: s.isDirectory() };
    },

    async mkdir(path: string): Promise<void> {
      await mkdir(path, { recursive: true });
    },
  };
}

export const files: FileProvider = createBunFileService();
