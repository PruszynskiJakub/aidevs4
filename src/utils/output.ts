import { join, extname } from "path";
import { randomUUID } from "crypto";
import { files } from "../services/file.ts";
import { config } from "../config/index.ts";

export type FileType = "document" | "image" | "audio" | "video";

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

export async function outputPath(filename: string): Promise<string> {
  const type = inferFileType(filename);
  const uuid = randomUUID();
  const dir = join(config.paths.outputDir, type, uuid);
  await files.mkdir(dir);
  return join(dir, filename);
}
