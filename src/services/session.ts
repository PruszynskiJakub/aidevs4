import type { LLMMessage } from "../types/llm.ts";
import type { Session } from "../types/session.ts";

function createSessionService() {
  const sessions = new Map<string, Session>();
  const queues = new Map<string, Promise<unknown>>();

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

    /** Visible for testing */
    _clear(): void {
      sessions.clear();
      queues.clear();
    },
  };
}

export const sessionService = createSessionService();
