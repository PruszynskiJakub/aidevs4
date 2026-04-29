import { resolve, relative } from "path";
import type { FileProvider, FileStat } from "../types/file.ts";
import { config } from "../config/index.ts";
import { getSessionId } from "../agent/context.ts";
import { safeParse, formatSizeMB } from "../utils/parse.ts";
import * as fs from "./fs.ts";
import { DomainError, isDomainError } from "../types/errors.ts";

// ── Helpers ─────────────────────────────────────────────────

function toRelative(absolutePath: string): string {
  const rel = relative(config.paths.projectRoot, resolve(absolutePath));
  return rel || ".";
}

function narrowOutputPaths(allowedDirs: string[], sessionsDir: string): string[] {
  const sessionId = getSessionId();
  if (!sessionId) return allowedDirs;

  const resolvedSessions = resolve(sessionsDir);
  const dateFolder = new Date().toISOString().slice(0, 10);
  const sessionDir = resolve(resolvedSessions, dateFolder, sessionId);
  return allowedDirs.map((dir) => {
    const resolved = resolve(dir);
    return resolved === resolvedSessions ? sessionDir : dir;
  });
}

function assertPathAllowed(
  targetPath: string,
  allowedDirs: string[],
  blockedDirs: string[],
  operation: "read" | "write",
  sessionsDir: string,
): void {
  const resolved = resolve(targetPath);
  const effective = operation === "write"
    ? narrowOutputPaths(allowedDirs, sessionsDir)
    : allowedDirs;

  const allowed = effective.some((dir) => {
    const resolvedDir = resolve(dir);
    return resolved === resolvedDir || resolved.startsWith(resolvedDir + "/");
  });
  if (!allowed) {
    throw new DomainError({
      type: "permission",
      message: `Access denied: cannot ${operation} the requested path`,
      internalMessage: `Access denied: cannot ${operation} "${toRelative(resolved)}". Allowed ${operation} directories: [${effective.map((d) => toRelative(d)).join(", ")}]`,
    });
  }

  if (operation === "write") {
    const blocked = blockedDirs.some((dir) => {
      const resolvedDir = resolve(dir);
      return resolved === resolvedDir || resolved.startsWith(resolvedDir + "/");
    });
    if (blocked) {
      throw new DomainError({
        type: "permission",
        message: `Access denied: target path is in a protected directory`,
        internalMessage: `Access denied: cannot write to "${toRelative(resolved)}" — path is in a protected directory.`,
      });
    }
  }
}

// ── Sandbox factory ─────────────────────────────────────────

export interface SandboxOptions {
  readPaths?: string[];
  writePaths?: string[];
  blockedWritePaths?: string[];
  sessionsDir?: string;
}

export function createSandbox(opts: SandboxOptions = {}): FileProvider {
  const readPaths = opts.readPaths ?? [...config.sandbox.allowedReadPaths];
  const writePaths = opts.writePaths ?? [...config.sandbox.allowedWritePaths];
  const blockedWritePaths = opts.blockedWritePaths ?? [...config.sandbox.blockedWritePaths];
  const sessionsDir = opts.sessionsDir ?? config.paths.sessionsDir;

  function assertRead(path: string): void {
    assertPathAllowed(path, readPaths, [], "read", sessionsDir);
  }

  function assertWrite(path: string): void {
    assertPathAllowed(path, writePaths, blockedWritePaths, "write", sessionsDir);
  }

  const svc: FileProvider = {
    async exists(path: string): Promise<boolean> {
      try {
        assertRead(path);
        return await fs.exists(path);
      } catch {
        return false;
      }
    },

    async readText(path: string): Promise<string> {
      assertRead(path);
      return fs.readText(path);
    },

    async readBinary(path: string): Promise<Buffer> {
      assertRead(path);
      return fs.readBinary(path);
    },

    async readJson<T = unknown>(path: string): Promise<T> {
      assertRead(path);
      return fs.readJson<T>(path);
    },

    async write(path: string, data: string | Response): Promise<void> {
      assertWrite(path);
      return fs.write(path, data);
    },

    async append(path: string, data: string): Promise<void> {
      assertWrite(path);
      return fs.append(path, data);
    },

    async readdir(path: string): Promise<string[]> {
      assertRead(path);
      return fs.fsReaddir(path);
    },

    async stat(path: string): Promise<FileStat> {
      assertRead(path);
      return fs.fsStat(path);
    },

    async mkdir(path: string): Promise<void> {
      assertWrite(path);
      return fs.fsMkdir(path);
    },

    async unlink(path: string): Promise<void> {
      assertWrite(path);
      return fs.fsUnlink(path);
    },

    async rename(from: string, to: string): Promise<void> {
      assertRead(from);
      assertWrite(to);
      return fs.fsRename(from, to);
    },

    async checkFileSize(path: string, maxBytes: number = config.limits.maxFileSize): Promise<void> {
      const s = await svc.stat(path);
      fs.checkFileSize(s, maxBytes, toRelative(path));
    },
  };

  return svc;
}

// ── Default singleton ───────────────────────────────────────

export let sandbox: FileProvider = createSandbox();

/** @internal Replace the sandbox singleton for testing. Returns a restore function. */
export function _setSandboxForTest(custom: FileProvider): () => void {
  const prev = sandbox;
  sandbox = custom;
  return () => { sandbox = prev; };
}

// ── resolveInput (used by specific tool handlers) ───────────

/**
 * Try to read `input` as a file path, parse as JSON. If that fails,
 * try parsing as inline JSON. Otherwise return the raw string.
 */
export async function resolveInput(
  input: string,
  label: string,
  fileProvider: FileProvider = sandbox,
): Promise<unknown> {
  try {
    const s = await fileProvider.stat(input);
    if (s.size > config.limits.maxFileSize) {
      throw new DomainError({
        type: "capacity",
        message: `File exceeds size limit of ${formatSizeMB(config.limits.maxFileSize)} MB`,
        internalMessage: `File ${toRelative(input)} is ${formatSizeMB(s.size)} MB — exceeds limit of ${formatSizeMB(config.limits.maxFileSize)} MB`,
      });
    }
    const content = await fileProvider.readText(input);
    return safeParse(content, label);
  } catch (err) {
    if (isDomainError(err) && err.type === "capacity") throw err;
  }

  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
