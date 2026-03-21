import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { files } from "../services/common/file.ts";
import { config } from "../config/index.ts";
import { getSessionId } from "../services/agent/session-context.ts";
import { inferCategory, type MediaCategory } from "./media-types.ts";

export type FileType = MediaCategory;
export const inferFileType = inferCategory;

// Process-level fallback for calls outside any session context
let fallbackSessionId: string | undefined;

export async function ensureOutputDir(): Promise<void> {
  await files.mkdir(config.paths.outputDir);
}

export function getEffectiveSessionId(): string {
  const id = getSessionId();
  if (id) return id;
  if (!fallbackSessionId) fallbackSessionId = randomUUID();
  return fallbackSessionId;
}

export async function outputPath(filename: string): Promise<string> {
  const sessionId = getEffectiveSessionId();
  const type = inferFileType(filename);
  const uuid = randomUUID();
  const dir = join(config.paths.outputDir, sessionId, type, uuid);
  await files.mkdir(dir);
  return join(dir, filename);
}

/**
 * Convert an absolute output path to a session-relative path.
 * e.g. `/abs/output/session-id/image/uuid/file.png` → `image/uuid/file.png`
 */
export function toSessionPath(absolutePath: string): string {
  const sessionId = getEffectiveSessionId();
  const sessionDir = join(config.paths.outputDir, sessionId) + "/";
  if (absolutePath.startsWith(sessionDir)) {
    return absolutePath.slice(sessionDir.length);
  }
  return absolutePath;
}

/**
 * Resolve a session-relative path to an absolute path.
 * If the path is already absolute, returns it unchanged.
 * e.g. `image/uuid/file.png` → `/abs/output/session-id/image/uuid/file.png`
 */
export function resolveSessionPath(pathOrRelative: string): string {
  if (pathOrRelative.startsWith("/")) return pathOrRelative;
  const sessionId = getEffectiveSessionId();
  return resolve(join(config.paths.outputDir, sessionId, pathOrRelative));
}
