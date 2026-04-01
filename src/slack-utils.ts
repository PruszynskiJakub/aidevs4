import type { BusEvent } from "./types/events.ts";

export const SLACK_MESSAGE_LIMIT = 4000;

/** Derive a stable session ID from a Slack thread. */
export function deriveSessionId(
  teamId: string,
  channelId: string,
  threadTs: string | undefined,
  messageTs: string,
): string {
  const ts = threadTs ?? messageTs;
  return `slack-${teamId}-${channelId}-${ts}`;
}

/** Convert GitHub-flavored markdown to Slack mrkdwn. */
export function toSlackMarkdown(md: string): string {
  let result = md;
  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");
  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");
  // Inline code is the same in both: `code`
  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  // Fenced code blocks: ```lang\n...\n``` → ```\n...\n```
  result = result.replace(/```\w*\n/g, "```\n");
  return result;
}

/** Split a long message into chunks that fit Slack's limit. */
export function splitMessage(text: string, limit = SLACK_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a paragraph boundary
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    // Fall back to line boundary
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", limit);
    // Fall back to word boundary
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", limit);
    // Last resort: hard cut
    if (splitAt <= 0) splitAt = limit;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  return chunks;
}

/** Format a bus event into a short status line, or null to skip. */
export function formatStatusLine(event: BusEvent): string | null {
  const { type, data } = event;
  const d = data as Record<string, unknown>;

  switch (type) {
    case "tool.called":
      return `Using *${d.name}*…`;
    case "tool.succeeded":
      return `*${d.name}* done (${d.durationMs}ms)`;
    case "tool.failed":
      return `*${d.name}* failed: ${String(d.error).slice(0, 100)}`;
    default:
      return null;
  }
}
