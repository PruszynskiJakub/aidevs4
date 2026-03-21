import { config } from "../config/index.ts";
import { files } from "../services/common/file.ts";

/**
 * Safe JSON.parse wrapper — returns typed result or throws a labelled error
 * that never echoes raw input (prevents stack trace leakage).
 */
export function safeParse<T = unknown>(json: string, label: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`Invalid JSON for ${label}`);
  }
}

const SAFE_FILENAME_RE = /^[a-zA-Z0-9_.\-]+$/;

/**
 * Validates that a filename is safe — no path separators, no traversal,
 * no hidden files, only alphanumeric + underscore + dot + hyphen.
 */
export function safeFilename(raw: string): string {
  if (!raw || raw.length === 0) {
    throw new Error("Filename must not be empty");
  }
  if (raw.includes("/") || raw.includes("\\")) {
    throw new Error("Filename must not contain path separators");
  }
  if (raw.includes("..")) {
    throw new Error("Filename must not contain '..'");
  }
  if (raw.startsWith(".")) {
    throw new Error("Filename must not be a hidden file");
  }
  if (!SAFE_FILENAME_RE.test(raw)) {
    throw new Error("Filename contains invalid characters — allowed: [a-zA-Z0-9_.-]");
  }
  return raw;
}

const POISONED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Rejects objects with prototype-pollution keys (__proto__, constructor, prototype).
 */
export function validateKeys(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (POISONED_KEYS.has(key)) {
      throw new Error(`Forbidden key: "${key}"`);
    }
  }
}

/**
 * Asserts that a string does not exceed maxLength.
 */
export function assertMaxLength(value: string, name: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new Error(`${name} exceeds max length of ${maxLength} characters`);
  }
}

/**
 * Validates that a number is finite and within [min, max].
 */
export function assertNumericBounds(value: number, name: string, min: number, max: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
}

/**
 * Resolves a dual-purpose input: file path → JSON string → raw string.
 * Resolution order: if `input` is a path to an existing file, read & parse it;
 * otherwise try JSON.parse; otherwise return the raw string.
 */
export async function resolveInput(input: string, label: string): Promise<unknown> {
  if (await files.exists(input)) {
    await checkFileSize(input);
    const content = await files.readText(input);
    return safeParse(content, label);
  }

  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/**
 * Checks that a file does not exceed the configured max size.
 * Uses fs.stat to avoid reading the file contents.
 */
export async function checkFileSize(path: string, maxBytes: number = config.limits.maxFileSize): Promise<void> {
  const s = await files.stat(path);
  if (s.size > maxBytes) {
    const sizeMB = (s.size / (1024 * 1024)).toFixed(1);
    const limitMB = (maxBytes / (1024 * 1024)).toFixed(1);
    throw new Error(`File ${path} is ${sizeMB} MB — exceeds limit of ${limitMB} MB`);
  }
}
