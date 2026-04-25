import { App } from "@slack/bolt";
import { randomUUID } from "node:crypto";
import { executeRun, type ExecuteRunResult } from "./agent/orchestrator.ts";
import { bus } from "./infra/events.ts";
import { log } from "./infra/log/logger.ts";
import { initServices, installSignalHandlers } from "./infra/bootstrap.ts";
import type { AgentEvent } from "./types/events.ts";
import type { RunExit } from "./agent/run-exit.ts";
import {
  deriveSessionId,
  toSlackMarkdown,
  splitMessage,
  StatusTracker,
} from "./slack-utils.ts";
import {
  getPendingConfirmationRequests,
  postConfirmationMessage,
  registerConfirmationActions,
} from "./slack-confirmation.ts";

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
  onEvent(event: AgentEvent): void;
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
    onEvent(event: AgentEvent) {
      if (destroyed) return;
      const text = tracker.update(event);
      if (!text) return;
      latestText = text;

      if (!timer) {
        flush();
        timer = setTimeout(() => { timer = null; }, THROTTLE_MS);
      } else {
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

/**
 * Thread location per run. Populated when we kick off a run so that,
 * after a button click, we know where to post the final answer. Lost
 * on process restart — users who clicked after a restart will see the
 * answer posted to the thread where they clicked, because slack-bolt
 * preserves channel/thread on the action payload. See the action
 * handler in registerConfirmationActions for the fallback flow.
 */
const runThread = new Map<string, { channel: string; threadTs: string }>();

registerConfirmationActions(app, {
  resolveThread(runId) {
    return runThread.get(runId);
  },
  async onResumed(result, channel, threadTs) {
    await handleResult(result, channel, threadTs);
  },
});

/** Track in-flight requests to deduplicate Slack retries. */
const inFlight = new Set<string>();

async function handleResult(
  result: ExecuteRunResult,
  channel: string,
  threadTs: string,
): Promise<void> {
  const { exit, runId } = result;

  if (exit.kind === "waiting") {
    runThread.set(runId, { channel, threadTs });
    const pending = getPendingConfirmationRequests(result.sessionId, runId);
    const confirmationId =
      exit.waitingOn.kind === "user_approval" ? exit.waitingOn.confirmationId : randomUUID();
    await postConfirmationMessage(app, channel, threadTs, runId, confirmationId, pending);
    return;
  }

  const text = exitToText(exit);
  if (!text) return;
  const slackText = toSlackMarkdown(text);
  for (const chunk of splitMessage(slackText)) {
    await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
  }
}

function exitToText(exit: RunExit): string {
  switch (exit.kind) {
    case "completed":
      return exit.result;
    case "failed":
      return `Error: ${exit.error.message.slice(0, 500)}`;
    case "cancelled":
      return `Cancelled: ${exit.reason}`;
    case "exhausted":
      return `Run exhausted after ${exit.cycleCount} cycles.`;
    case "waiting":
      return "";
  }
}

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

  try {
    await app.client.reactions.add({
      channel: channelId,
      name: "thinking_face",
      timestamp: messageTs,
    });
  } catch {
    // Non-critical
  }

  const status = createStatusUpdater(app, channelId, replyThread);

  const unsubscribe = bus.onAny((event: AgentEvent) => {
    if (event.sessionId !== sessionId) return;
    status.onEvent(event);
  });

  try {
    const result = await executeRun({ sessionId, prompt: text });
    await handleResult(result, channelId, replyThread);
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

await initServices();
installSignalHandlers(async () => { await app.stop(); });

await app.start();
log.info("[slack] Bot is running in Socket Mode");
