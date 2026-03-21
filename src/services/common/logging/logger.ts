// Backward-compatible facade — re-exports from new modules
import type { Logger } from "../../../types/logger.ts";
import { ConsoleLogger } from "./console-logger.ts";
import { elapsed } from "../../../utils/timing.ts";

export type Log = Logger;

export { elapsed };

/** @deprecated Use `elapsed` from utils/timing instead */
export const duration = elapsed;

export const log: Logger = new ConsoleLogger();
