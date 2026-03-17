// Backward-compatible facade — re-exports from new modules
import type { Logger } from "../types/logger.ts";
import { ConsoleLogger } from "./console-logger.ts";

export type Log = Logger;

export function elapsed(startPerfNow: number): string {
  const seconds = (performance.now() - startPerfNow) / 1000;
  return `${seconds.toFixed(2)}s`;
}

/** @deprecated Use `elapsed` instead */
export const duration = elapsed;

export const log: Logger = new ConsoleLogger();
