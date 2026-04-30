import { join } from "node:path";
import * as fs from "../fs.ts";
import type { AgentEvent, WildcardListener } from "../../types/events.ts";
import type { JsonlWriter } from "../../types/logger.ts";
import { config } from "../../config/index.ts";

export type { JsonlWriter } from "../../types/logger.ts";

function dateFolderFromTs(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function defaultPathFn(event: AgentEvent): string {
  const folder = dateFolderFromTs(event.ts);
  const sid = event.sessionId ?? "_global";
  return join(config.paths.sessionsDir, folder, sid, "log", "events.jsonl");
}

/** Envelope keys that should not appear in the persisted `data` object. */
const ENVELOPE_KEYS = new Set([
  "id", "type", "ts", "sessionId", "correlationId",
  "runId", "rootRunId", "parentRunId", "traceId", "depth",
]);

function extractPayload(event: AgentEvent): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (!ENVELOPE_KEYS.has(k) && v !== undefined) data[k] = v;
  }
  return data;
}

/**
 * Creates a JSONL persistence listener.
 *
 * Each event is serialised to one JSON line and appended to a file
 * determined by `pathFn` (defaults to `logs/{date}/{sessionId}/events.jsonl`).
 *
 * Writes are chained internally so ordering is preserved without blocking
 * the bus. Call `flush()` to wait for all pending writes.
 */
export function createJsonlWriter(
  pathFn: (event: AgentEvent) => string = defaultPathFn,
): JsonlWriter {
  let chain: Promise<void> = Promise.resolve();
  const ensuredDirs = new Set<string>();

  function listener(event: AgentEvent): void {
    const data = compactData(event.type, extractPayload(event));
    const line = JSON.stringify({
      id: event.id,
      type: event.type,
      ts: event.ts,
      ...(event.sessionId && { sid: event.sessionId }),
      ...(event.correlationId && { cid: event.correlationId }),
      data,
    });

    const filePath = pathFn(event);
    const dir = filePath.slice(0, filePath.lastIndexOf("/"));

    chain = chain
      .then(async () => {
        if (!ensuredDirs.has(dir)) {
          await fs.fsMkdir(dir);
          ensuredDirs.add(dir);
        }
        await fs.append(filePath, line + "\n");
      })
      .catch((err) => {
        console.error("[jsonl] write error:", err);
      });
  }

  function flush(): Promise<void> {
    return chain;
  }

  const exitHandler = () => {
    // Best-effort flush on exit — can't await in sync handler,
    // but the chained promise should already be mostly drained.
  };
  process.on("beforeExit", exitHandler);

  function dispose(): void {
    process.removeListener("beforeExit", exitHandler);
  }

  return { listener, flush, dispose };
}

/** Strip large rendering-only fields from event data before persisting. */
function compactData(type: string, data: Record<string, unknown>): Record<string, unknown> {
  if (type === "generation.completed") {
    const { input, ...rest } = data;
    return rest;
  }
  if (type === "tool.succeeded") {
    const { result, ...rest } = data;
    return rest;
  }
  return data;
}
