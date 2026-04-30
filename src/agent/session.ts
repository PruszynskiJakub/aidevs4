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

// ── Types ──────────────────────────────────────────────────

type DbItem = {
  type: string; role: string | null; content: string | null;
  callId: string | null; name: string | null; arguments: string | null; output: string | null;
};

// ── Message ↔ Item conversion ──────────────────────────────

function userMessageToItem(runId: string, msg: LLMMessage & { role: "user" }, seq: number): NewItem {
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  return { id: randomUUID(), runId, sequence: seq, type: "message", role: "user", content };
}

function assistantMessageToItems(runId: string, msg: LLMAssistantMessage, startSeq: number): NewItem[] {
  let seq = startSeq;
  const items: NewItem[] = [{
    id: randomUUID(), runId, sequence: seq++, type: "message", role: "assistant",
    content: msg.content ?? undefined,
  }];
  for (const tc of msg.toolCalls ?? []) {
    items.push({
      id: randomUUID(), runId, sequence: seq++, type: "function_call",
      callId: tc.id, name: tc.function.name, arguments: tc.function.arguments,
      // Store providerMetadata (e.g. Gemini thoughtSignature) in the
      // otherwise unused content column for function_call items.
      content: tc.providerMetadata ? JSON.stringify(tc.providerMetadata) : undefined,
    });
  }
  return items;
}

function messagesToItems(runId: string, messages: LLMMessage[], startSeq: number): NewItem[] {
  const result: NewItem[] = [];
  let seq = startSeq;
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      result.push(userMessageToItem(runId, msg as LLMMessage & { role: "user" }, seq++));
    } else if (msg.role === "assistant") {
      const items = assistantMessageToItems(runId, msg as LLMAssistantMessage, seq);
      result.push(...items);
      seq += items.length;
    } else if (msg.role === "tool") {
      result.push({
        id: randomUUID(), runId, sequence: seq++, type: "function_call_output",
        callId: msg.toolCallId, output: msg.content,
      });
    }
  }
  return result;
}

function parseUserContent(raw: string | null): string | import("../types/llm.ts").ContentPart[] {
  if (raw === null) return "";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  return raw;
}

function collectAssistantToolCalls(items: DbItem[], from: number): { calls: LLMToolCall[]; nextIdx: number } {
  const calls: LLMToolCall[] = [];
  let j = from;
  while (j < items.length && items[j].type === "function_call") {
    const fc = items[j];
    let providerMetadata: Record<string, unknown> | undefined;
    if (fc.content) {
      try { providerMetadata = JSON.parse(fc.content); } catch { /* ignore */ }
    }
    calls.push({
      id: fc.callId!,
      type: "function",
      function: { name: fc.name!, arguments: fc.arguments! },
      ...(providerMetadata && { providerMetadata }),
    });
    j++;
  }
  return { calls, nextIdx: j };
}

function itemsToMessages(dbItems: DbItem[]): LLMMessage[] {
  const messages: LLMMessage[] = [];
  let i = 0;
  while (i < dbItems.length) {
    const item = dbItems[i];
    if (item.type === "message" && item.role === "user") {
      messages.push({ role: "user", content: parseUserContent(item.content) });
      i++;
    } else if (item.type === "message" && item.role === "assistant") {
      const { calls, nextIdx } = collectAssistantToolCalls(dbItems, i + 1);
      const msg: LLMAssistantMessage = {
        role: "assistant",
        content: item.content ?? null,
        ...(calls.length > 0 && { toolCalls: calls }),
      };
      messages.push(msg);
      i = nextIdx;
    } else if (item.type === "function_call_output") {
      messages.push({ role: "tool", toolCallId: item.callId!, content: item.output ?? "" });
      i++;
    } else {
      i++;
    }
  }
  return messages;
}

// ── Persistence helper ─────────────────────────────────────

function persistMessages(runId: string, msgs: LLMMessage[], tx?: dbOps.DbOrTx): void {
  if (msgs.length === 0) return;
  const seq = dbOps.nextSequence(runId, tx);
  const items = messagesToItems(runId, msgs, seq);
  if (items.length === 0) return;
  if (items.length === 1) dbOps.appendItem(items[0], tx);
  else dbOps.appendItems(items, tx);
}

// ── Factory: Message store ─────────────────────────────────

function createMessageStore() {
  return {
    appendMessage(id: string, runId: string, message: LLMMessage, tx?: dbOps.DbOrTx): void {
      if (message.role === "system") return;
      persistMessages(runId, [message], tx);
      dbOps.touchSession(id, tx);
    },
    appendRun(id: string, runId: string, messages: LLMMessage[], tx?: dbOps.DbOrTx): void {
      const nonSystem = messages.filter((m) => m.role !== "system");
      if (nonSystem.length === 0) return;
      persistMessages(runId, nonSystem, tx);
      dbOps.touchSession(id, tx);
    },
    getMessages(id: string, runId?: string): LLMMessage[] {
      const dbItems = runId ? dbOps.listItemsByRun(runId) : dbOps.listItemsBySession(id);
      return itemsToMessages(dbItems);
    },
  };
}

// ── Factory: Session registry ──────────────────────────────

function dbSessionToSession(row: { id: string; assistant: string | null; createdAt: string; updatedAt: string }, msgs: LLMMessage[]): Session {
  return {
    id: row.id,
    assistant: row.assistant ?? undefined,
    messages: msgs,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function createSessionRegistry(getMessages: (id: string) => LLMMessage[]) {
  const queues = new Map<string, Promise<unknown>>();

  return {
    getOrCreate(id: string): Session {
      const existing = dbOps.getSession(id);
      if (existing) return dbSessionToSession(existing, getMessages(id));
      dbOps.createSession(id);
      return { id, messages: [], createdAt: new Date(), updatedAt: new Date() };
    },
    setAssistant(id: string, assistant: string): void {
      dbOps.setAssistant(id, assistant);
    },
    /**
     * Enqueue an async task for a session. Tasks on the same session run
     * serially; different sessions run concurrently.
     */
    enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
      const prev = queues.get(sessionId) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      queues.set(sessionId, next);
      const cleanup = () => { if (queues.get(sessionId) === next) queues.delete(sessionId); };
      next.then(cleanup, cleanup);
      return next;
    },
    _clearQueues(): void { queues.clear(); },
  };
}

// ── Factory: Session paths ─────────────────────────────────

function dateFolderNow(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve the working directory for the current session.
 * Used by tools that need a per-session CWD (bash, execute_code).
 * Pass an explicit `sessionId` to avoid the ALS lookup — preferred for
 * any tool that has access to a `RunCtx`.
 */
export function getSessionWorkingDir(sessionId?: string): string {
  const id = sessionId ?? getSessionId();
  if (id) {
    return resolve(join(defaultConfig.paths.sessionsDir, dateFolderNow(), id));
  }
  return resolve(defaultConfig.paths.sessionsDir);
}

function createSessionPaths(fileService: FileProvider, sessionsDir: string) {
  let fallbackSessionId: string | undefined;

  /**
   * Resolve the active sessionId. Prefer an explicitly-passed value;
   * fall back to the ALS lookup; finally generate a one-shot fallback
   * for callers that have no session context (tests, scripts).
   */
  const getEffectiveSessionId = (sessionId?: string): string => {
    const explicit = sessionId ?? getSessionId();
    if (explicit) return explicit;
    if (!fallbackSessionId) fallbackSessionId = randomSessionId();
    return fallbackSessionId;
  };

  /** workspace/sessions/{YYYY-MM-DD}/{sessionId} */
  const sessionDir = (dateFolder?: string, sessionId?: string): string => {
    const date = dateFolder ?? dateFolderNow();
    return join(sessionsDir, date, getEffectiveSessionId(sessionId));
  };

  return {
    getEffectiveSessionId,
    sessionDir,
    /** workspace/sessions/{YYYY-MM-DD}/{sessionId}/log/ */
    logDir(dateFolder?: string, sessionId?: string): string { return join(sessionDir(dateFolder, sessionId), "log"); },
    /** workspace/sessions/{YYYY-MM-DD}/{sessionId}/shared/ */
    sharedDir(dateFolder?: string, sessionId?: string): string { return join(sessionDir(dateFolder, sessionId), "shared"); },
    async ensureSessionDir(sessionId?: string): Promise<void> { await fileService.mkdir(sessionDir(undefined, sessionId)); },
    async outputPath(filename: string, sessionId?: string, agentName?: string): Promise<string> {
      const dir = join(sessionDir(undefined, sessionId), agentName ?? getAgentName(), "output");
      await fileService.mkdir(dir);
      return join(dir, `${randomSessionId()}${extname(filename)}`);
    },
    toSessionPath(absolutePath: string, sessionId?: string): string {
      const marker = `/${getEffectiveSessionId(sessionId)}/`;
      const idx = absolutePath.indexOf(marker);
      return idx !== -1 ? absolutePath.slice(idx + marker.length) : absolutePath;
    },
    resolveSessionPath(pathOrRelative: string, sessionId?: string): string {
      if (pathOrRelative.startsWith("/")) return pathOrRelative;
      return resolve(join(sessionDir(undefined, sessionId), pathOrRelative));
    },
    _clearFallback(): void { fallbackSessionId = undefined; },
  };
}

// ── Composed service ───────────────────────────────────────

function createSessionService(
  fileService: FileProvider = defaultFiles,
  sessionsDir: string = defaultConfig.paths.sessionsDir,
) {
  const messageStore = createMessageStore();
  const registry = createSessionRegistry(messageStore.getMessages);
  const paths = createSessionPaths(fileService, sessionsDir);

  return {
    ...messageStore,
    ...registry,
    ...paths,
    /** Visible for testing */
    _clear(): void {
      registry._clearQueues();
      paths._clearFallback();
      dbOps._clearAll();
    },
  };
}

// ── Exports ────────────────────────────────────────────────

export type SessionService = ReturnType<typeof createSessionService>;

export { createSessionService, messagesToItems, itemsToMessages };

export const sessionService = createSessionService();
