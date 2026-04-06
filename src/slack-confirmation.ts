import type { App } from "@slack/bolt";
import type {
  ConfirmationProvider,
  ConfirmationRequest,
} from "./agent/confirmation.ts";
import type { Decision } from "./types/tool.ts";
import { requireSessionId } from "./agent/context.ts";
import { log } from "./infra/log/logger.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const ARGS_DISPLAY_LIMIT = 200;

interface ThreadContext {
  channel: string;
  threadTs: string;
}

interface PendingBatch {
  resolve: (decisions: Map<string, Decision>) => void;
  timeout: ReturnType<typeof setTimeout>;
  decisions: Map<string, Decision>;
  callIds: string[];
  messageTs: string | null;
  channel: string;
  threadTs: string;
}

export class SlackConfirmationProvider implements ConfirmationProvider {
  private threadContexts = new Map<string, ThreadContext>();
  private pendingBatches = new Map<string, PendingBatch>();
  private callToBatch = new Map<string, string>();

  constructor(
    private boltApp: App,
    private timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.registerActionHandlers();
  }

  setThreadContext(sessionId: string, ctx: ThreadContext): void {
    this.threadContexts.set(sessionId, ctx);
  }

  clearThreadContext(sessionId: string): void {
    this.threadContexts.delete(sessionId);
  }

  async confirm(requests: ConfirmationRequest[]): Promise<Map<string, Decision>> {
    const sessionId = requireSessionId();
    const ctx = this.threadContexts.get(sessionId);

    if (!ctx) {
      log.error(`[slack-confirm] No thread context for session ${sessionId}, auto-denying`);
      return new Map(requests.map((r) => [r.callId, "deny" as const]));
    }

    return new Promise<Map<string, Decision>>((resolve) => {
      const callIds = requests.map((r) => r.callId);
      const batch: PendingBatch = {
        resolve,
        timeout: setTimeout(() => this.handleTimeout(sessionId), this.timeoutMs),
        decisions: new Map(),
        callIds,
        messageTs: null,
        channel: ctx.channel,
        threadTs: ctx.threadTs,
      };

      this.pendingBatches.set(sessionId, batch);
      for (const callId of callIds) {
        this.callToBatch.set(callId, sessionId);
      }

      this.postConfirmationMessage(batch, requests).catch((err) => {
        log.error(`[slack-confirm] Failed to post confirmation message: ${err}`);
        this.resolveBatch(sessionId, new Map(callIds.map((id) => [id, "deny" as const])));
      });
    });
  }

  private async postConfirmationMessage(
    batch: PendingBatch,
    requests: ConfirmationRequest[],
  ): Promise<void> {
    const blocks: Record<string, unknown>[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":warning:  *Action requires approval*",
        },
      },
      { type: "divider" },
    ];

    for (const req of requests) {
      const argsStr = truncateArgs(req.args);
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*\`${req.toolName}\`*\n${argsStr}`,
        },
      });
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            action_id: `confirm_approve_${req.callId}`,
            value: req.callId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Deny" },
            style: "danger",
            action_id: `confirm_deny_${req.callId}`,
            value: req.callId,
          },
        ],
      });
    }

    const res = await this.boltApp.client.chat.postMessage({
      channel: batch.channel,
      thread_ts: batch.threadTs,
      text: "Action requires approval",
      blocks,
    });

    batch.messageTs = res.ts ?? null;
  }

  private registerActionHandlers(): void {
    this.boltApp.action(/^confirm_approve_/, async ({ action, ack }) => {
      await ack();
      if (action.type !== "button") return;
      const callId = action.action_id.replace("confirm_approve_", "");
      this.recordDecision(callId, "approve");
    });

    this.boltApp.action(/^confirm_deny_/, async ({ action, ack }) => {
      await ack();
      if (action.type !== "button") return;
      const callId = action.action_id.replace("confirm_deny_", "");
      this.recordDecision(callId, "deny");
    });
  }

  private recordDecision(callId: string, decision: Decision): void {
    const sessionId = this.callToBatch.get(callId);
    if (!sessionId) return;

    const batch = this.pendingBatches.get(sessionId);
    if (!batch) return;

    // Idempotent — ignore duplicate clicks
    if (batch.decisions.has(callId)) return;

    batch.decisions.set(callId, decision);

    if (batch.decisions.size >= batch.callIds.length) {
      this.resolveBatch(sessionId, batch.decisions);
    }
  }

  private handleTimeout(sessionId: string): void {
    const batch = this.pendingBatches.get(sessionId);
    if (!batch) return;

    // Auto-deny all undecided calls
    for (const callId of batch.callIds) {
      if (!batch.decisions.has(callId)) {
        batch.decisions.set(callId, "deny");
      }
    }

    this.resolveBatch(sessionId, batch.decisions, true);
  }

  private resolveBatch(
    sessionId: string,
    decisions: Map<string, Decision>,
    timedOut = false,
  ): void {
    const batch = this.pendingBatches.get(sessionId);
    if (!batch) return;

    clearTimeout(batch.timeout);
    this.pendingBatches.delete(sessionId);
    for (const callId of batch.callIds) {
      this.callToBatch.delete(callId);
    }

    this.updateMessageAfterResolution(batch, decisions, timedOut).catch((err) => {
      log.error(`[slack-confirm] Failed to update confirmation message: ${err}`);
    });

    batch.resolve(decisions);
  }

  private async updateMessageAfterResolution(
    batch: PendingBatch,
    decisions: Map<string, Decision>,
    timedOut: boolean,
  ): Promise<void> {
    if (!batch.messageTs) return;

    const lines = batch.callIds.map((callId) => {
      const decision = decisions.get(callId) ?? "deny";
      if (timedOut && decision === "deny") {
        return `:hourglass:  \`${callId}\` — _Timed out_`;
      }
      return decision === "approve"
        ? `:white_check_mark:  \`${callId}\` — *Approved*`
        : `:no_entry_sign:  \`${callId}\` — *Denied*`;
    });

    await this.boltApp.client.chat.update({
      channel: batch.channel,
      ts: batch.messageTs,
      text: timedOut ? "Action timed out" : "Action resolved",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: lines.join("\n"),
          },
        },
      ],
    });
  }
}

function truncateArgs(args: Record<string, unknown>): string {
  const str = JSON.stringify(args, null, 2);
  if (str.length <= ARGS_DISPLAY_LIMIT) return `\`\`\`${str}\`\`\``;
  return `\`\`\`${str.slice(0, ARGS_DISPLAY_LIMIT)}…\`\`\``;
}