import { join, resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
import type { LLMMessage, LLMAssistantMessage, LLMToolCall } from "../types/llm.ts";
import type { Session } from "../types/session.ts";
import type { FileProvider } from "../types/file.ts";
import type { NewItem } from "../types/db.ts";
import { randomSessionId } from "../utils/id.ts";
import { getSessionId, getAgentName } from "./context.ts";
import { sandbox as defaultFiles } from "../infra/sandbox.ts";
import { config as defaultConfig } from "../config/index.ts";
import * as dbOps from "../infra/db/index.ts";

function dateFolderNow(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Message ↔ Item conversion ───────────────────────────────

function messagesToItems(runId: string, messages: LLMMessage[], startSeq: number): NewItem[] {
  const result: NewItem[] = [];
  let seq = startSeq;

  for (const msg of messages) {
    if (msg.role === "system") continue; // system prompts are not persisted

    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
      result.push({
        id: randomUUID(),
        runId,
        sequence: seq++,
        type: "message",
        role: "user",
        content,
      });
    } else if (msg.role === "assistant") {
      const assistantMsg = msg as LLMAssistantMessage;
      result.push({
        id: randomUUID(),
        runId,
        sequence: seq++,
        type: "message",
        role: "assistant",
        content: assistantMsg.content ?? undefined,
      });
      if (assistantMsg.toolCalls) {
        for (const tc of assistantMsg.toolCalls) {
          result.push({
            id: randomUUID(),
            runId,
            sequence: seq++,
            type: "function_call",
            callId: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
            // Store providerMetadata (e.g. Gemini thoughtSignature) in the
            // otherwise unused content column for function_call items.
            content: tc.providerMetadata ? JSON.stringify(tc.providerMetadata) : undefined,
          });
        }
      }
    } else if (msg.role === "tool") {
      result.push({
        id: randomUUID(),
        runId,
        sequence: seq++,
        type: "function_call_output",
        callId: msg.toolCallId,
        output: msg.content,
      });
    }
  }
  return result;
}

function itemsToMessages(dbItems: { type: string; role: string | null; content: string | null; callId: string | null; name: string | null; arguments: string | null; output: string | null }[]): LLMMessage[] {
  const messages: LLMMessage[] = [];
  let i = 0;

  while (i < dbItems.length) {
    const item = dbItems[i];

    if (item.type === "message" && item.role === "user") {
      let content: string | import("../types/llm.ts").ContentPart[];
      try {
        const parsed = JSON.parse(item.content ?? "");
        if (Array.isArray(parsed)) {
          content = parsed;
        } else {
          content = item.content ?? "";
        }
      } catch {
        content = item.content ?? "";
      }
      messages.push({ role: "user", content });
      i++;
    } else if (item.type === "message" && item.role === "assistant") {
      const toolCalls: LLMToolCall[] = [];
      // Collect subsequent function_call items that belong to this assistant message
      let j = i + 1;
      while (j < dbItems.length && dbItems[j].type === "function_call") {
        const fc = dbItems[j];
        let providerMetadata: Record<string, unknown> | undefined;
        if (fc.content) {
          try { providerMetadata = JSON.parse(fc.content); } catch { /* ignore */ }
        }
        toolCalls.push({
          id: fc.callId!,
          type: "function",
          function: {
            name: fc.name!,
            arguments: fc.arguments!,
          },
          ...(providerMetadata && { providerMetadata }),
        });
        j++;
      }
      const msg: LLMAssistantMessage = {
        role: "assistant",
        content: item.content ?? null,
        ...(toolCalls.length > 0 && { toolCalls }),
      };
      messages.push(msg);
      i = j;
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        toolCallId: item.callId!,
        content: item.output ?? "",
      });
      i++;
    } else {
      // Skip unexpected items (e.g. orphaned function_call not preceded by assistant)
      i++;
    }
  }

  return messages;
}

// ── Session service ─────────────────────────────────────────

function createSessionService(
  fileService: FileProvider = defaultFiles,
  sessionsDir: string = defaultConfig.paths.sessionsDir,
) {
  const queues = new Map<string, Promise<unknown>>();

  // Process-level fallback for calls outside any session context
  let fallbackSessionId: string | undefined;

  return {
    getOrCreate(id: string): Session {
      const existing = dbOps.getSession(id);
      if (existing) {
        const msgs = this.getMessages(id);
        return {
          id: existing.id,
          assistant: existing.assistant ?? undefined,
          messages: msgs,
          createdAt: new Date(existing.createdAt),
          updatedAt: new Date(existing.updatedAt),
        };
      }
      dbOps.createSession(id);
      return { id, messages: [], createdAt: new Date(), updatedAt: new Date() };
    },

    setAssistant(id: string, assistant: string): void {
      dbOps.setAssistant(id, assistant);
    },

    appendMessage(id: string, runId: string, message: LLMMessage): void {
      if (message.role === "system") return;
      const seq = dbOps.nextSequence(runId);
      const newItems = messagesToItems(runId, [message], seq);
      for (const item of newItems) {
        dbOps.appendItem(item);
      }
      dbOps.touchSession(id);
    },

    appendRun(id: string, runId: string, messages: LLMMessage[]): void {
      const nonSystem = messages.filter((m) => m.role !== "system");
      if (nonSystem.length === 0) return;
      const seq = dbOps.nextSequence(runId);
      const newItems = messagesToItems(runId, nonSystem, seq);
      dbOps.appendItems(newItems);
      dbOps.touchSession(id);
    },

    getMessages(id: string, runId?: string): LLMMessage[] {
      const dbItems = runId
        ? dbOps.listItemsByRun(runId)
        : dbOps.listItemsBySession(id);
      return itemsToMessages(dbItems);
    },

    /**
     * Enqueue an async task for a session. Tasks on the same session run
     * serially; different sessions run concurrently.
     */
    enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
      const prev = queues.get(sessionId) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      queues.set(sessionId, next);
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
      const uuid = randomSessionId();
      const ext = extname(filename);
      const dir = join(this.sessionDir(), agentName, "output");
      await fileService.mkdir(dir);
      return join(dir, `${uuid}${ext}`);
    },

    toSessionPath(absolutePath: string): string {
      const sessionId = this.getEffectiveSessionId();
      const marker = `/${sessionId}/`;
      const idx = absolutePath.indexOf(marker);
      if (idx !== -1) {
        return absolutePath.slice(idx + marker.length);
      }
      return absolutePath;
    },

    resolveSessionPath(pathOrRelative: string): string {
      if (pathOrRelative.startsWith("/")) return pathOrRelative;
      return resolve(join(this.sessionDir(), pathOrRelative));
    },

    /** Visible for testing */
    _clear(): void {
      queues.clear();
      fallbackSessionId = undefined;
      dbOps._clearAll();
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

export { createSessionService, messagesToItems, itemsToMessages };

export const sessionService = createSessionService();
