import { bus } from "./events.ts";
import { initTracing, shutdownTracing } from "./tracing.ts";
import { attachLangfuseSubscriber } from "./langfuse-subscriber.ts";
import { initMcpTools, shutdownMcp } from "../tools/index.ts";

export async function initServices(): Promise<void> {
  initTracing();
  attachLangfuseSubscriber(bus);
  await initMcpTools();
}

export async function shutdownServices(): Promise<void> {
  await shutdownTracing();
  await shutdownMcp();
}

export function installSignalHandlers(extra?: () => Promise<void>): void {
  async function gracefulShutdown() {
    await shutdownServices();
    if (extra) await extra();
  }

  process.on("beforeExit", () => { gracefulShutdown(); });
  process.on("SIGTERM", async () => {
    await gracefulShutdown();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await gracefulShutdown();
    process.exit(0);
  });
}