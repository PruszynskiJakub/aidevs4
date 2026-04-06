import { App } from "@slack/bolt";
import { executeTurn } from "./agent/orchestrator.ts";
import { bus } from "./infra/events.ts";
import { log } from "./infra/log/logger.ts";
import { initMcpTools, shutdownMcp } from "./tools/index.ts";
import { initTracing, shutdownTracing } from "./infra/tracing.ts";
import { attachLangfuseSubscriber } from "./infra/langfuse-subscriber.ts";
import type { BusEvent } from "./types/events.ts";
import {
  deriveSessionId,
  toSlackMarkdown,
  splitMessage,
  StatusTracker,
} from "./slack-utils.ts";
import { setConfirmationProvider } from "./agent/confirmation.ts";
import { SlackConfirmationProvider } from "./slack-confirmation.ts";

// ── Config ─────────────────────────────────────────────────

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required. Exiting.");
  process.exit(0);
}

const THROTTLE_MS = 1_000;

// ── Throttled status updater ───────────────────────────────

interface StatusUpdater {
  onEvent(event: BusEvent): void;
  destroy(): void;
}

function createStatusUpdater(
  boltApp: App,
  channel: string,
  threadTs: string,
): StatusUpdater {
  const tracker = new StatusTracker();
  let statusTs: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestText: string | null = null;
  let destroyed = false;

  async function flush() {
    if (destroyed || !latestText) return;
    const text = latestText;

    try {
      if (!statusTs) {
        const res = await boltApp.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text,
        });
        statusTs = res.ts ?? null;
      } else {
        await boltApp.client.chat.update({
          channel,
          ts: statusTs,
          text,
        });
      }
    } catch (err: unknown) {
      if (err && typeof err === "object" && "data" in err) {
        const data = (err as { data?: { retry_after?: number } }).data;
        if (data?.retry_after) {
          timer = setTimeout(() => flush(), data.retry_after * 1000);
          return;
        }
      }
      log.error(`[slack] status update failed: ${err}`);
    }
  }

  return {
    onEvent(event: BusEvent) {
      if (destroyed) return;
      const text = tracker.update(event);
      if (!text) return;
      latestText = text;

      if (!timer) {
        flush();
        timer = setTimeout(() => { timer = null; }, THROTTLE_MS);
      } else {
        // Will be picked up after throttle window
        clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, THROTTLE_MS);
      }
    },
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// ── Bolt app ───────────────────────────────────────────────

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

const slackConfirmation = new SlackConfirmationProvider(app);
setConfirmationProvider(slackConfirmation);

/** Track in-flight requests to deduplicate Slack retries. */
const inFlight = new Set<string>();

async function handleMessage(
  channelId: string,
  teamId: string,
  text: string | undefined,
  threadTs: string | undefined,
  messageTs: string,
) {
  if (!text || text.trim() === "") return;

  const replyThread = threadTs ?? messageTs;
  const dedupeKey = `${channelId}:${messageTs}`;

  if (inFlight.has(dedupeKey)) return;
  inFlight.add(dedupeKey);

  const sessionId = deriveSessionId(teamId, channelId, threadTs, messageTs);
  slackConfirmation.setThreadContext(sessionId, { channel: channelId, threadTs: replyThread });

  try {
    await app.client.reactions.add({
      channel: channelId,
      name: "thinking_face",
      timestamp: messageTs,
    });
  } catch {
    // Non-critical
  }

  // Subscribe to event bus BEFORE calling executeTurn
  const status = createStatusUpdater(app, channelId, replyThread);

  const unsubscribe = bus.onAny((event: BusEvent) => {
    if (event.sessionId !== sessionId) return;
    status.onEvent(event);
  });

  try {
    const { answer } = await executeTurn({
      sessionId,
      prompt: text,
    });

    if (answer) {
      const slackText = toSlackMarkdown(answer);
      const chunks = splitMessage(slackText);
      for (const chunk of chunks) {
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: replyThread,
          text: chunk,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[slack] agent error [${sessionId}]: ${message}`);
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: replyThread,
      text: `Error: ${message.slice(0, 500)}`,
    }).catch(() => {});
  } finally {
    unsubscribe();
    status.destroy();
    slackConfirmation.clearThreadContext(sessionId);
    inFlight.delete(dedupeKey);

    try {
      await app.client.reactions.remove({
        channel: channelId,
        name: "thinking_face",
        timestamp: messageTs,
      });
    } catch {
      // Non-critical
    }
  }
}

app.message(async ({ message }) => {
  if (message.subtype) return;
  if (!("text" in message)) return;

  await handleMessage(
    message.channel,
    ((message as unknown as Record<string, string>).team) ?? "unknown",
    message.text,
    message.thread_ts,
    message.ts,
  );
});

app.event("app_mention", async ({ event }) => {
  await handleMessage(
    event.channel,
    ((event as unknown as Record<string, string>).team) ?? "unknown",
    event.text,
    event.thread_ts,
    event.ts,
  );
});

// ── Startup ────────────────────────────────────────────────

initTracing();
attachLangfuseSubscriber(bus);
await initMcpTools();

async function gracefulShutdown() {
  await shutdownTracing();
  await shutdownMcp();
  await app.stop();
}

process.on("SIGTERM", async () => {
  await gracefulShutdown();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await gracefulShutdown();
  process.exit(0);
});

await app.start();
log.info("[slack] Bot is running in Socket Mode");
