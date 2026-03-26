import { join, resolve } from "node:path";
import type { LLMMessage } from "../types/llm.ts";
import type { Session } from "../types/session.ts";
import type { FileProvider } from "../types/file.ts";
import { inferCategory } from "../utils/media-types.ts";
import { randomSessionId } from "../utils/id.ts";
import { getSessionId, getAgentName } from "./context.ts";
import { files as defaultFiles } from "../infra/file.ts";
import { config as defaultConfig } from "../config/index.ts";

function dateFolderNow(): string {
  return new Date().toISOString().slice(0, 10);
}

function createSessionService(
  fileService: FileProvider = defaultFiles,
  sessionsDir: string = defaultConfig.paths.sessionsDir,
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
      // Clean up queue entry once this promise settles to avoid unbounded growth
      next.then(() => {
        if (queues.get(sessionId) === next) queues.delete(sessionId);
      }, () => {
        if (queues.get(sessionId) === next) queues.delete(sessionId);
      });
      return next;
    },

    // ── Path helpers ─────────────────────────────────────────────

    getEffectiveSessionId(): string {
      const id = getSessionId();
      if (id) return id;
      if (!fallbackSessionId) fallbackSessionId = randomSessionId();
      return fallbackSessionId;
    },

    /** workspace/sessions/{YYYY-MM-DD}/{sessionId} */
    sessionDir(dateFolder?: string): string {
      const date = dateFolder ?? dateFolderNow();
      const sid = this.getEffectiveSessionId();
      return join(sessionsDir, date, sid);
    },

    /** workspace/sessions/{YYYY-MM-DD}/{sessionId}/log/ */
    logDir(dateFolder?: string): string {
      return join(this.sessionDir(dateFolder), "log");
    },

    /** workspace/sessions/{YYYY-MM-DD}/{sessionId}/shared/ */
    sharedDir(dateFolder?: string): string {
      return join(this.sessionDir(dateFolder), "shared");
    },

    async ensureSessionDir(): Promise<void> {
      await fileService.mkdir(this.sessionDir());
    },

    async outputPath(filename: string): Promise<string> {
      const agentName = getAgentName();
      const type = inferCategory(filename);
      const uuid = randomSessionId();
      const dir = join(this.sessionDir(), agentName, "output", type, uuid);
      await fileService.mkdir(dir);
      return join(dir, filename);
    },

    /**
     * Convert an absolute path to a session-relative path.
     * Strips everything up to and including {sessionId}/ prefix.
     */
    toSessionPath(absolutePath: string): string {
      const sessionId = this.getEffectiveSessionId();
      const marker = `/${sessionId}/`;
      const idx = absolutePath.indexOf(marker);
      if (idx !== -1) {
        return absolutePath.slice(idx + marker.length);
      }
      return absolutePath;
    },

    /**
     * Resolve a session-relative path to an absolute path.
     * If the path is already absolute, returns it unchanged.
     */
    resolveSessionPath(pathOrRelative: string): string {
      if (pathOrRelative.startsWith("/")) return pathOrRelative;
      return resolve(join(this.sessionDir(), pathOrRelative));
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
