import type { Runtime } from "../runtime.ts";
import type { RunState } from "./run-state.ts";
import type { Logger } from "./logger.ts";

/**
 * The per-run object that the agent core, dispatcher, and tool handlers
 * read their dependencies from.
 *
 * Mirrors Wonderlands' `CommandContext`: a small bag composed once per
 * run that combines (a) boot-time services (`runtime`) with (b) the
 * run-scoped invariants (`state`, `log`). Threaded through `dispatch`
 * and into tool handlers via `ToolCallContext`. Replaces the
 * `requireState()` / `requireLogger()` AsyncLocalStorage accessors as
 * tools migrate to read it explicitly.
 */
export interface RunContext {
  runtime: Runtime;
  state: RunState;
  log: Logger;
}
