import { readdir, stat, mkdir, appendFile, unlink, rename } from "node:fs/promises";
import type { FileStat } from "../types/file.ts";
import { DomainError } from "../types/errors.ts";

// ── Pure filesystem functions — no access control ────────────

export async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function readText(path: string): Promise<string> {
  return Bun.file(path).text();
}

export async function readBinary(path: string): Promise<Buffer> {
  const arrayBuf = await Bun.file(path).arrayBuffer();
  return Buffer.from(arrayBuf);
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return Bun.file(path).json() as Promise<T>;
}

export async function write(path: string, data: string | Response): Promise<void> {
  if (data instanceof Response) {
    await Bun.write(path, await data.arrayBuffer());
  } else {
    await Bun.write(path, data);
  }
}

export async function append(path: string, data: string): Promise<void> {
  await appendFile(path, data);
}

export async function fsReaddir(path: string): Promise<string[]> {
  return readdir(path);
}

export async function fsStat(path: string): Promise<FileStat> {
  const s = await stat(path);
  return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
}

export async function fsMkdir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function fsUnlink(path: string): Promise<void> {
  await unlink(path);
}

export async function fsRename(from: string, to: string): Promise<void> {
  await rename(from, to);
}

export function checkFileSize(
  fileStat: FileStat,
  maxBytes: number,
  displayPath: string,
): void {
  if (fileStat.size > maxBytes) {
    const sizeMB = (fileStat.size / (1024 * 1024)).toFixed(2);
    const limitMB = (maxBytes / (1024 * 1024)).toFixed(2);
    throw new DomainError({
      type: "capacity",
      message: `File exceeds size limit of ${limitMB} MB`,
      internalMessage: `File ${displayPath} is ${sizeMB} MB — exceeds limit of ${limitMB} MB`,
    });
  }
}
