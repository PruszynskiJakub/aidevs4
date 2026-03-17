import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FileProvider } from "../types/file.ts";
import { createBunFileService } from "./file.ts";
import { config } from "../config/index.ts";

const SAFE_ID = /^[a-zA-Z0-9_\-]+$/;

function dateFolder(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function formatDate(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** Generate a UUID v4 string for anonymous sessions */
export function randomSessionId(): string {
  return randomUUID();
}

/** Pretty-print JSON with 2-space indent; fall back to raw string on parse failure */
export function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export class MarkdownLogger {
  readonly filePath: string;
  readonly sessionId: string;
  private chain: Promise<void> = Promise.resolve();
  private fs: FileProvider;

  constructor(options?: { logsDir?: string; sessionId?: string; fs?: FileProvider }) {
    const logsDir = options?.logsDir ?? config.paths.logsDir;
    const sid = options?.sessionId ?? randomSessionId();

    if (!SAFE_ID.test(sid)) {
      throw new Error("Invalid session ID: must match /^[a-zA-Z0-9_\\-]+$/");
    }

    this.fs = options?.fs ?? createBunFileService([], [logsDir]);
    this.sessionId = sid;
    const dir = join(logsDir, dateFolder(), sid);
    this.filePath = join(dir, `log_${timeStamp()}.md`);
    // Kick off directory creation — subsequent appends chain after it
    this.chain = this.fs.mkdir(dir);
  }

  private append(text: string): void {
    this.chain = this.chain.then(() => this.fs.append(this.filePath, text));
  }

  /** Wait for all pending writes to complete */
  async flush(): Promise<void> {
    await this.chain;
  }

  init(prompt: string): void {
    this.append(
      `# Agent Log — ${formatDate()}\n\n` +
      `## User Prompt\n\n${prompt}\n\n---\n\n`,
    );
  }

  step(iter: number, max: number, model: string, msgCount: number): void {
    this.append(
      `## Step ${iter}/${max}\n\n` +
      `- **Model**: ${model}\n` +
      `- **Messages**: ${msgCount}\n\n`,
    );
  }

  llm(elapsed: string, tokensIn?: number, tokensOut?: number): void {
    const tokenStr = tokensIn != null ? ` | ${tokensIn} → ${tokensOut} tokens` : "";
    this.append(`**LLM responded** in ${elapsed}${tokenStr}\n\n`);
  }

  plan(planText: string, model: string, elapsed: string, tokensIn?: number, tokensOut?: number): void {
    const tokenStr = tokensIn != null ? ` | ${tokensIn} → ${tokensOut} tokens` : "";
    this.append(
      `### Plan\n\n` +
      `*Model: ${model} · ${elapsed}${tokenStr}*\n\n` +
      `${planText}\n\n`,
    );
  }

  toolHeader(count: number): void {
    const parallel = count > 1 ? ", parallel" : "";
    this.append(`### Tool Calls (${count}${parallel})\n\n`);
  }

  toolCall(name: string, rawArgs: string): void {
    this.append(
      `#### \`${name}\`\n\n` +
      `**Arguments:**\n\`\`\`json\n${formatJson(rawArgs)}\n\`\`\`\n\n`,
    );
  }

  toolOk(name: string, elapsed: string, rawResult: string, hints?: string[]): void {
    let text =
      `**Result** (${elapsed}) — OK\n\n` +
      `\`\`\`json\n${formatJson(rawResult)}\n\`\`\`\n\n`;
    if (hints?.length) {
      text += `> **Hints:**\n`;
      for (const hint of hints) {
        text += `> - ${hint}\n`;
      }
      text += `\n`;
    }
    this.append(text);
  }

  toolErr(name: string, errorMsg: string): void {
    this.append(
      `**Result** — ERROR\n\n` +
      `\`\`\`\n${errorMsg}\n\`\`\`\n\n`,
    );
  }

  batchDone(count: number, elapsed: string): void {
    this.append(`*Batch complete: ${count} tools in ${elapsed}*\n\n---\n\n`);
  }

  answer(text: string | null): void {
    this.append(
      `---\n\n## Final Answer\n\n${text ?? "(no response)"}\n`,
    );
  }

  maxIter(max: number): void {
    this.append(
      `---\n\n## STOPPED — reached ${max} iterations\n`,
    );
  }
}
