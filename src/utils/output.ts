import { join, extname } from "path";
import { randomUUID } from "crypto";
import { files } from "../services/common/file.ts";
import { config } from "../config/index.ts";
import { getSessionId } from "../services/agent/session-context.ts";

export type FileType = "document" | "image" | "audio" | "video";

// Process-level fallback for calls outside any session context
let fallbackSessionId: string | undefined;

const EXT_MAP: Record<string, FileType> = {
  // images
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
  ".bmp": "image",
  ".ico": "image",
  // audio
  ".mp3": "audio",
  ".wav": "audio",
  ".ogg": "audio",
  ".flac": "audio",
  ".aac": "audio",
  ".m4a": "audio",
  ".wma": "audio",
  // video
  ".mp4": "video",
  ".avi": "video",
  ".mov": "video",
  ".mkv": "video",
  ".webm": "video",
  ".wmv": "video",
  ".flv": "video",
};

export function inferFileType(filename: string): FileType {
  const ext = extname(filename).toLowerCase();
  return EXT_MAP[ext] ?? "document";
}

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
