import type { App } from "@slack/bolt";
import type { ConfirmationRequest } from "./agent/confirmation.ts";
import type { Decision } from "./types/tool.ts";
import type { ExecuteRunResult } from "./agent/orchestrator.ts";
import type { LLMMessage, LLMAssistantMessage } from "./types/llm.ts";
import type { Runtime } from "./runtime.ts";
import { resumeRun } from "./agent/resume-run.ts";
import { sessionService } from "./agent/session.ts";
import { log } from "./infra/log/logger.ts";
import { safeParse } from "./utils/parse.ts";
import * as dbOps from "./infra/db/index.ts";

const ARGS_DISPLAY_LIMIT = 200;

/**
 * Button action_id encodes: runId, confirmationId, toolCallId, and decision.
 * Slack action_ids have a 255-char limit; runId (uuid) + confirmationId (uuid)
 * + toolCallId (~50) is well under that budget.
 */
const ACTION_PREFIX_APPROVE = "cnf_app:";
const ACTION_PREFIX_DENY = "cnf_deny:";

function encodeAction(
  prefix: string,
  runId: string,
  confirmationId: string,
  toolCallId: string,
): string {
  return `${prefix}${runId}|${confirmationId}|${toolCallId}`;
}

function decodeAction(actionId: string): {
  decision: Decision;
  runId: string;
  confirmationId: string;
  toolCallId: string;
} | null {
  let decision: Decision;
  let rest: string;
  if (actionId.startsWith(ACTION_PREFIX_APPROVE)) {
    decision = "approve";
    rest = actionId.slice(ACTION_PREFIX_APPROVE.length);
  } else if (actionId.startsWith(ACTION_PREFIX_DENY)) {
    decision = "deny";
    rest = actionId.slice(ACTION_PREFIX_DENY.length);
  } else {
    return null;
  }
  const [runId, confirmationId, toolCallId] = rest.split("|");
  if (!runId || !confirmationId || !toolCallId) return null;
  return { decision, runId, confirmationId, toolCallId };
}

/**
 * Extract pending tool calls from the persisted transcript of a run.
 * Pending = toolCalls on the latest assistant message without matching
 * function_call_output items.
 */
export function getPendingConfirmationRequests(
  sessionId: string,
  runId: string,
): ConfirmationRequest[] {
  const messages = sessionService.getMessages(sessionId, runId);
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) answered.add(m.toolCallId);
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as LLMMessage;
    if (m.role !== "assistant") continue;
    const asst = m as LLMAssistantMessage;
    if (!asst.toolCalls?.length) continue;
    const pending = asst.toolCalls.filter((tc) => !answered.has(tc.id));
    if (pending.length === 0) return [];
    return pending.map((tc) => ({
      toolCallId: tc.id,
      toolName: tc.function.name,
      args: safeParse<Record<string, unknown>>(tc.function.arguments, tc.function.name),
    }));
  }
  return [];
}

function truncateArgs(args: Record<string, unknown>): string {
  const str = JSON.stringify(args, null, 2);
  if (str.length <= ARGS_DISPLAY_LIMIT) return `\`\`\`${str}\`\`\``;
  return `\`\`\`${str.slice(0, ARGS_DISPLAY_LIMIT)}…\`\`\``;
}

export async function postConfirmationMessage(
  boltApp: App,
  channel: string,
  threadTs: string,
  runId: string,
  confirmationId: string,
  requests: ConfirmationRequest[],
): Promise<void> {
  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: ":warning:  *Action requires approval*" },
    },
    { type: "divider" },
  ];

  for (const req of requests) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*\`${req.toolName}\`*\n${truncateArgs(req.args)}`,
      },
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: encodeAction(ACTION_PREFIX_APPROVE, runId, confirmationId, req.toolCallId),
          value: req.toolCallId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          action_id: encodeAction(ACTION_PREFIX_DENY, runId, confirmationId, req.toolCallId),
          value: req.toolCallId,
        },
      ],
    });
  }

  await boltApp.client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "Action requires approval",
    blocks,
  });
}

interface RegisterOpts {
  onResumed: (result: ExecuteRunResult, channel: string, threadTs: string) => Promise<void>;
  resolveThread: (runId: string) => { channel: string; threadTs: string } | undefined;
}

/**
 * Register action handlers that collect decisions per run and, once
 * all pending tool calls have been answered, call `resumeRun`. Works
 * across process restarts because every click carries full state
 * (runId, confirmationId, toolCallId, decision) and the run is
 * loaded fresh from the DB each time.
 */
export function registerConfirmationActions(app: App, opts: RegisterOpts, runtime: Runtime): void {
  // In-process accumulator for multi-tool batches. After restart, a
  // user who already clicked N of M buttons will need to click the
  // remaining ones to complete the resolution — each click recovers
  // state from the DB.
  const partialDecisions = new Map<string, Map<string, Decision>>();

  async function handleClick(actionId: string): Promise<void> {
    const decoded = decodeAction(actionId);
    if (!decoded) return;

    const { decision, runId, confirmationId, toolCallId } = decoded;

    const run = dbOps.getRun(runId);
    if (!run) {
      log.error(`[slack-confirm] unknown run ${runId}`);
      return;
    }
    if (run.status !== "waiting") {
      log.info(`[slack-confirm] run ${runId} no longer waiting (status=${run.status})`);
      return;
    }

    const pending = getPendingConfirmationRequests(run.sessionId, runId);
    if (pending.length === 0) return;

    const key = `${runId}:${confirmationId}`;
    let decisions = partialDecisions.get(key);
    if (!decisions) {
      decisions = new Map();
      partialDecisions.set(key, decisions);
    }
    decisions.set(toolCallId, decision);

    if (decisions.size < pending.length) return;

    partialDecisions.delete(key);

    try {
      const result = await resumeRun(runId, {
        kind: "user_approval",
        confirmationId,
        decisions: Object.fromEntries(decisions),
      }, runtime);
      const thread = opts.resolveThread(runId);
      if (thread) await opts.onResumed(result, thread.channel, thread.threadTs);
    } catch (err) {
      log.error(`[slack-confirm] resumeRun failed: ${err}`);
    }
  }

  app.action(/^cnf_app:/, async ({ action, ack }) => {
    await ack();
    if (action.type !== "button") return;
    await handleClick(action.action_id);
  });

  app.action(/^cnf_deny:/, async ({ action, ack }) => {
    await ack();
    if (action.type !== "button") return;
    await handleClick(action.action_id);
  });
}
