import { join, resolve } from "path";
import { randomUUID } from "crypto";
import type { LLMMessage } from "../../types/llm.ts";
import type { Session } from "../../types/session.ts";
import type { FileProvider } from "../../types/file.ts";
import { inferCategory, type MediaCategory } from "../../utils/media-types.ts";
import { getSessionId } from "./session-context.ts";
import { files as defaultFiles } from "../common/file.ts";
import { config as defaultConfig } from "../../config/index.ts";

export type FileType = MediaCategory;
export const inferFileType = inferCategory;

function createSessionService(
  fileService: FileProvider = defaultFiles,
  outputDir: string = defaultConfig.paths.outputDir,
) {
  const sessions = new Map<string, Session>();
  const queues = new Map<string, Promise<unknown>>();

  // Process-level fallback for calls outside any session context
  let fallbackSessionId: string | undefined;

  return {
    getOrCreate(id: string): Session {
      let session = sessions.get(id);
      if (!session) {
        session = { id, messages: [], createdAt: new Date(), updatedAt: new Date() };
        sessions.set(id, session);
      }
      return session;
    },

    appendMessage(id: string, message: LLMMessage): void {
      const session = this.getOrCreate(id);
      session.messages.push(message);
      session.updatedAt = new Date();
    },

    getMessages(id: string): LLMMessage[] {
      return this.getOrCreate(id).messages;
    },

    /**
     * Enqueue an async task for a session. Tasks on the same session run
     * serially; different sessions run concurrently.
     */
    enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
      const prev = queues.get(sessionId) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      queues.set(sessionId, next);
      return next;
    },

    // ── Output path management ──────────────────────────────────

    async ensureOutputDir(): Promise<void> {
      await fileService.mkdir(outputDir);
    },

    getEffectiveSessionId(): string {
      const id = getSessionId();
      if (id) return id;
      if (!fallbackSessionId) fallbackSessionId = randomUUID();
      return fallbackSessionId;
    },

    async outputPath(filename: string): Promise<string> {
      const sessionId = this.getEffectiveSessionId();
      const type = inferFileType(filename);
      const uuid = randomUUID();
      const dir = join(outputDir, sessionId, type, uuid);
      await fileService.mkdir(dir);
      return join(dir, filename);
    },

    /**
     * Convert an absolute output path to a session-relative path.
     * e.g. `/abs/output/session-id/image/uuid/file.png` → `image/uuid/file.png`
     */
    toSessionPath(absolutePath: string): string {
      const sessionId = this.getEffectiveSessionId();
      const sessionDir = join(outputDir, sessionId) + "/";
      if (absolutePath.startsWith(sessionDir)) {
        return absolutePath.slice(sessionDir.length);
      }
      return absolutePath;
    },

    /**
     * Resolve a session-relative path to an absolute path.
     * If the path is already absolute, returns it unchanged.
     * e.g. `image/uuid/file.png` → `/abs/output/session-id/image/uuid/file.png`
     */
    resolveSessionPath(pathOrRelative: string): string {
      if (pathOrRelative.startsWith("/")) return pathOrRelative;
      const sessionId = this.getEffectiveSessionId();
      return resolve(join(outputDir, sessionId, pathOrRelative));
    },

    /** Visible for testing */
    _clear(): void {
      sessions.clear();
      queues.clear();
      fallbackSessionId = undefined;
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

export { createSessionService };

export const sessionService = createSessionService();