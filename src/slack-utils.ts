import type { BusEvent } from "./types/events.ts";

export const SLACK_MESSAGE_LIMIT = 4000;

/** Derive a stable session ID from a Slack thread. */
export function deriveSessionId(
  teamId: string,
  channelId: string,
  threadTs: string | undefined,
  messageTs: string,
): string {
  const ts = (threadTs ?? messageTs).replace(/\./g, "-");
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

/**
 * Tracks tool activity and renders a compact single-line status.
 * Instead of appending lines per event, it maintains a running summary
 * like: ":gear: Using web, grep… (2 done)"
 */
export class StatusTracker {
  private active = new Set<string>();
  private history: { name: string; ok: boolean }[] = [];

  /** Process an event. Returns updated status string, or null if no change. */
  update(event: BusEvent): string | null {
    const { type, data } = event;
    const d = data as Record<string, unknown>;
    const name = d.name as string | undefined;

    switch (type) {
      case "tool.called":
        if (name) this.active.add(name);
        return this.render();
      case "tool.succeeded":
        if (name) {
          this.active.delete(name);
          this.history.push({ name, ok: true });
        }
        return this.render();
      case "tool.failed":
        if (name) {
          this.active.delete(name);
          this.history.push({ name, ok: false });
        }
        return this.render();
      default:
        return null;
    }
  }

  private render(): string {
    const lines: string[] = [];

    // Show completed tools as a log
    for (const h of this.history) {
      const icon = h.ok ? ":white_check_mark:" : ":x:";
      lines.push(`${icon}  \`${h.name}\``);
    }

    // Show currently active tools
    if (this.active.size > 0) {
      const names = [...this.active].map(n => `\`${n}\``).join(", ");
      lines.push(`:gear:  ${names}…`);
    }

    if (lines.length === 0) return ":hourglass_flowing_sand:  _Working…_";
    return lines.join("\n");
  }
}
