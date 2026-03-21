/** Shared media type constants — single source of truth for extension → type/MIME mapping. */

import { extname } from "path";

export type MediaCategory = "image" | "text" | "audio" | "video" | "document";

export const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
]);

export const TEXT_EXTENSIONS = new Set([
  ".txt", ".csv", ".tsv", ".log", ".md", ".json", ".xml", ".html",
]);

const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".avi", ".mov", ".mkv", ".webm", ".wmv", ".flv",
]);

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/** All supported extensions for document processing (images + text). */
export const ALL_SUPPORTED_EXTENSIONS: readonly string[] = Object.freeze(
  [...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS].sort(),
);

function getExt(filename: string): string {
  return extname(filename).toLowerCase();
}

/** Infer media category from file extension. */
export function inferCategory(filename: string): MediaCategory {
  const ext = getExt(filename);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "document";
}

/** Infer MIME type from file extension. Returns a correct MIME string. */
export function inferMimeType(filename: string): string {
  const ext = getExt(filename);
  return MIME_MAP[ext] ?? (TEXT_EXTENSIONS.has(ext) ? "text/plain" : "application/octet-stream");
}