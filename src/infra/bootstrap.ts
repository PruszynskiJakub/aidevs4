import { config } from "../config/index.ts";
import { bus } from "./events.ts";
import { initTracing, isTracingEnabled, shutdownTracing } from "./tracing.ts";
import { attachLangfuseSubscriber } from "./langfuse-subscriber.ts";
import { initMcpTools, shutdownMcp } from "../tools/index.ts";
import { sqlite } from "./db/connection.ts";

export async function initServices(): Promise<void> {
  // DB connection is initialized on import of connection.ts (above).
  // Migrations are NOT run here — they run as a dedicated startup step
  // via `bun run db:migrate` before the app starts.
  console.log(`[boot] env=${config.env} db=${config.database.url} langfuse=${isTracingEnabled() ? "on" : "off"}`);
  initTracing();
  attachLangfuseSubscriber(bus);
  await initMcpTools();
}

export async function shutdownServices(): Promise<void> {
  await shutdownTracing();
  await shutdownMcp();
  sqlite.close();
}

export function installSignalHandlers(extra?: () => Promise<void>): void {
  async function gracefulShutdown() {
    await shutdownServices();
    if (extra) await extra();
  }

  process.on("SIGTERM", async () => {
    await gracefulShutdown();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await gracefulShutdown();
    process.exit(0);
  });
}