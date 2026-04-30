/**
 * Per-run execution context — the explicit replacement for the
 * `AsyncLocalStorage<RunContext>` in `context.ts`.
 *
 * Mirrors Wonderlands' two-context shape:
 *   - `Runtime` (composition root, process-lifetime)  →  `runtime`
 *   - `CommandContext` (per-request lifetime)         →  `RunCtx` (this file)
 *   - `ToolContext` (per-tool-call lifetime)          →  `ToolCtx` (this file)
 *
 * `RunCtx` is built once at the top of `runAgent` and threaded as a
 * parameter through every helper inside the loop. Helpers stop reading
 * from ALS; envelope/identity fields are read off `ctx`.
 *
 * `ToolCtx` is built per dispatch by the tool registry — it adds the
 * fields a tool handler needs that the surrounding loop already has,
 * plus per-call additions (`toolCallId`, `abortSignal`).
 *
 * No ALS. No module-level singletons reached for through this type.
 * Everything a callee needs is on the parameter or comes from
 * `ctx.runtime`.
 */

import type { RunState } from "../types/run-state.ts";
import type { Logger } from "../types/logger.ts";
import type { FileProvider } from "../types/file.ts";
import type { Runtime } from "../runtime.ts";

export interface RunCtx {
  /** Composition root — config + service registry, process-lifetime. */
  runtime: Runtime;
  /** Composite logger (markdown + console) wired up at runAgent entry. */
  log: Logger;
  /** Mutable run state — messages, tokens, iteration counter, model, tools. */
  state: RunState;
  /**
   * Session-scoped file provider. Writes to `sessionsDir` are narrowed
   * to this run's per-session subfolder without consulting ALS.
   */
  files: FileProvider;
  /** Stable identity fields, snapshotted from state at ctx-build time. */
  sessionId: string;
  runId?: string;
  rootRunId?: string;
  parentRunId?: string;
  traceId?: string;
  depth: number;
  agentName: string;
}

export interface ToolCtx extends RunCtx {
  /** The LLM-assigned id for this tool call (function_call.id). */
  toolCallId: string;
  /** Optional cancel signal threaded down from the loop. */
  abortSignal?: AbortSignal;
}

/**
 * Build a `RunCtx` from a `Runtime` + the live `RunState` + the loop's
 * logger. Identity fields are read off `state` once; later mutations to
 * `state.runId`/`state.depth` (which only happen at run-startup before
 * any helper runs) are not reflected here — by design, the ctx is the
 * stable snapshot for the run.
 */
export function buildRunCtx(runtime: Runtime, state: RunState, log: Logger): RunCtx {
  return {
    runtime,
    log,
    state,
    files: runtime.files.scoped(state.sessionId),
    sessionId: state.sessionId,
    runId: state.runId,
    rootRunId: state.rootRunId,
    parentRunId: state.parentRunId,
    traceId: state.traceId,
    depth: state.depth ?? 0,
    agentName: state.agentName ?? state.assistant ?? "default",
  };
}

/**
 * Derive a `ToolCtx` from a `RunCtx` for one tool invocation. The
 * dispatcher is the only intended caller.
 */
export function toToolCtx(
  ctx: RunCtx,
  toolCallId: string,
  abortSignal?: AbortSignal,
): ToolCtx {
  return { ...ctx, toolCallId, ...(abortSignal && { abortSignal }) };
}
