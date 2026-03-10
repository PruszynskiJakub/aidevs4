import { mkdir } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function formatDate(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
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
  private chain: Promise<void> = Promise.resolve();

  constructor(logsDir?: string) {
    const dir = logsDir ?? join(import.meta.dir, "..", "..", "logs");
    this.filePath = join(dir, `log_${timestamp()}.md`);
    // Kick off directory creation — subsequent appends chain after it
    this.chain = mkdir(dir, { recursive: true }).then(() => {});
  }

  private append(text: string): void {
    this.chain = this.chain.then(() => appendFile(this.filePath, text));
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
    this.append(
      `**Result** (${elapsed}) — OK\n\n` +
      `\`\`\`json\n${formatJson(rawResult)}\n\`\`\`\n\n`,
    );
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
