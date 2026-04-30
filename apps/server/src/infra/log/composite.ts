import type { Logger } from "../../types/logger.ts";

/**
 * Delegates every Logger method call to all targets.
 * Uses a Proxy to avoid manually maintaining 14+ forwarding methods.
 */
export function createCompositeLogger(targets: Logger[]): Logger {
  return new Proxy({} as Logger, {
    get(_obj, prop: string) {
      return (...args: unknown[]) => {
        for (const t of targets) {
          (t as unknown as Record<string, Function>)[prop](...args);
        }
      };
    },
  });
}
