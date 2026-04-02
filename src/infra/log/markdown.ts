import { join } from "node:path";
import type { FileProvider } from "../../types/file.ts";
import type { Logger } from "../../types/logger.ts";
import { createBunFileService } from "../file.ts";
import { config } from "../../config/index.ts";
import { randomSessionId } from "../../utils/id.ts";

const SAFE_ID = /^[a-zA-Z0-9_\-]+$/;
const MAX_INLINE_SIZE = 10_240;

function utcTimestamp(): { folder: string; stamp: string; display: string } {
  const iso = new Date().toISOString();
  return {
    folder: iso.slice(0, 10),                           // 2026-03-17
    stamp: iso.slice(11, 19).replace(/:/g, "-"),         // 14-30-05
    display: iso.replace("T", " ").slice(0, 19),         // 2026-03-17 14:30:05
  };
}

/** Pretty-print JSON with 2-space indent; fall back to raw string on parse failure */
export function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function tokenSuffix(tokensIn?: number, tokensOut?: number): string {
  return tokensIn != null ? ` | ${tokensIn} → ${tokensOut} tokens` : "";
}

export class MarkdownLogger implements Logger {
  readonly filePath: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  private chain: Promise<void> = Promise.resolve();
  private fs: FileProvider;
  private _exitHandler: () => void;

  constructor(options?: { logsDir?: string; sessionId?: string; fs?: FileProvider }) {
    const sessionsDir = options?.logsDir ?? config.paths.sessionsDir;
    const sid = options?.sessionId ?? randomSessionId();

    if (!SAFE_ID.test(sid)) {
      throw new Error("Invalid session ID: must match /^[a-zA-Z0-9_\\-]+$/");
    }

    const ts = utcTimestamp();
    const sessionDir = join(sessionsDir, ts.folder, sid);
    // Use the exact session directory as write path so sandbox narrowing
    // doesn't block child sessions called from a parent's async context.
    this.fs = options?.fs ?? createBunFileService([], [sessionDir]);
    this.sessionId = sid;
    const dir = join(sessionDir, "log");
    this.sessionDir = dir;
    this.filePath = join(dir, `log_${ts.stamp}.md`);
    // Kick off directory creation — subsequent appends chain after it
    this.chain = this.fs.mkdir(dir);
    this._exitHandler = () => { this.flush(); };
    process.on("beforeExit", this._exitHandler);
  }

  dispose(): void {
    process.removeListener("beforeExit", this._exitHandler);
  }

  private append(text: string): void {
    this.chain = this.chain.then(() =>
      this.fs.append(this.filePath, text).catch(() => {/* logging must not throw */}),
    );
  }

  /** Wait for all pending writes to complete */
  async flush(): Promise<void> {
    await this.chain;
  }

  init(prompt: string): void {
    const ts = utcTimestamp();
    this.append(
      `# Agent Log — ${ts.display}\n\n` +
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
    this.append(`**LLM responded** in ${elapsed}${tokenSuffix(tokensIn, tokensOut)}\n\n`);
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

  toolOk(name: string, elapsed: string, rawResult: string): void {
    let text: string;
    if (rawResult.length > MAX_INLINE_SIZE) {
      const ts = utcTimestamp();
      const rand = Math.random().toString(36).slice(2, 6);
      const sidecarName = `${name}_${ts.stamp}_${rand}.txt`;
      const sidecarPath = join(this.sessionDir, sidecarName);
      this.chain = this.chain.then(() =>
        this.fs.write(sidecarPath, rawResult).catch(() => {}),
      );
      text =
        `**Result** (${elapsed}) — OK\n\n` +
        `> Output too large (${rawResult.length} bytes). See [full output](${sidecarName})\n\n`;
    } else {
      text =
        `**Result** (${elapsed}) — OK\n\n` +
        `\`\`\`xml\n${rawResult}\n\`\`\`\n\n`;
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

  info(message: string): void {
    this.append(`**ℹ Info:** ${message}\n\n`);
  }

  success(message: string): void {
    this.append(`**✓ Success:** ${message}\n\n`);
  }

  error(message: string): void {
    this.append(`**✗ Error:** ${message}\n\n`);
  }

  debug(message: string): void {
    this.append(`*Debug: ${message}*\n\n`);
  }

  memoryObserve(tokensBefore: number, tokensAfter: number): void {
    this.append(
      `**Memory — Observe:** ${tokensBefore} → ${tokensAfter} tokens (observations)\n\n`,
    );
  }

  memoryReflect(level: number, tokensBefore: number, tokensAfter: number): void {
    this.append(
      `**Memory — Reflect (level ${level}):** ${tokensBefore} → ${tokensAfter} tokens\n\n`,
    );
  }
}
