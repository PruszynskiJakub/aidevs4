import type { Logger, LogLevel } from "../../../types/logger.ts";

// ANSI color constants
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const WHITE = "\x1b[37m";
const BG_RED = "\x1b[41m";
const BG_GREEN = "\x1b[42m";

const BAR = `${DIM}${"─".repeat(50)}${RESET}`;

/** Truncate string to maxLen, appending "…" if cut */
function truncate(s: string, maxLen = 120): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

/** Truncate a value for display: strings are sliced, objects are JSON-stringified */
function formatVal(v: unknown, maxLen: number): string {
  if (typeof v === "string") return truncate(v, maxLen);
  if (typeof v === "object") return truncate(JSON.stringify(v), maxLen);
  return String(v);
}

/** Summarize tool arguments: show key=value pairs, truncate long values */
function summarizeArgs(raw: string, truncateArgs: number): string {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return truncate(raw, 80);
    return Object.entries(obj).map(([k, v]) => `${k}: ${formatVal(v, truncateArgs)}`).join(", ");
  } catch {
    return truncate(raw, 80);
  }
}

/** Summarize tool result: show key info, truncate */
function summarizeResult(raw: string, truncateResult: number): string {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return truncate(raw, 100);
    if (obj.error) return `${RED}error: ${obj.error}${RESET}`;
    const summary = Object.entries(obj)
      .filter(([k]) => k !== "preview" && k !== "content")
      .map(([k, v]) => `${k}: ${formatVal(v, 40)}`)
      .join(", ");
    return truncate(summary, truncateResult);
  } catch {
    return truncate(raw, 100);
  }
}

function tokenSuffix(tokensIn?: number, tokensOut?: number): string {
  return tokensIn != null ? `  ${DIM}(${tokensIn} → ${tokensOut} tokens)${RESET}` : "";
}

/** Level ordering: debug < info == success < warn < error */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  error: 2,
};

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  truncateArgs?: number;
  truncateResult?: number;
}

export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly truncateArgsLen: number;
  private readonly truncateResultLen: number;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.level = options.level ?? "debug";
    this.truncateArgsLen = options.truncateArgs ?? 50;
    this.truncateResultLen = options.truncateResult ?? 120;
  }

  private isEnabled(messageLevel: LogLevel): boolean {
    return LEVEL_ORDER[messageLevel] >= LEVEL_ORDER[this.level];
  }

  // --- Agent-loop methods (always output regardless of log level) ---

  step(iter: number, max: number, model: string, msgCount: number): void {
    console.log("");
    console.log(BAR);
    console.log(
      `${BOLD}${WHITE} Step ${iter}/${max}${RESET}` +
      `${DIM}  ·  ${model}  ·  ${msgCount} msgs${RESET}`
    );
    console.log(BAR);
  }

  llm(elapsed: string, tokensIn?: number, tokensOut?: number): void {
    console.log(`  ${CYAN}⚡${RESET} LLM responded in ${BOLD}${elapsed}${RESET}${tokenSuffix(tokensIn, tokensOut)}`);
  }

  plan(planText: string, model: string, elapsed: string, tokensIn?: number, tokensOut?: number): void {
    console.log(`  ${CYAN}📋${RESET} Plan updated ${DIM}(${model}, ${elapsed})${RESET}${tokenSuffix(tokensIn, tokensOut)}`);
    for (const line of planText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.includes("[x]")) {
        console.log(`     ${DIM}${trimmed}${RESET}`);
      } else if (trimmed.includes("[>]")) {
        console.log(`     ${BOLD}${YELLOW}${trimmed}${RESET}`);
      } else if (trimmed.includes("[ ]")) {
        console.log(`     ${WHITE}${trimmed}${RESET}`);
      }
    }
  }

  toolHeader(count: number): void {
    const parallel = count > 1 ? ` in parallel` : "";
    console.log(`  ${YELLOW}🔧 Calling ${count} tool${count > 1 ? "s" : ""}${parallel}:${RESET}`);
  }

  toolCall(name: string, rawArgs: string): void {
    console.log(`     ${DIM}→${RESET} ${BOLD}${name}${RESET}${DIM}(${summarizeArgs(rawArgs, this.truncateArgsLen)})${RESET}`);
  }

  toolOk(name: string, elapsed: string, rawResult: string): void {
    console.log(`  ${GREEN}✔ ${name}${RESET} ${DIM}${elapsed}${RESET}`);
    const summary = summarizeResult(rawResult, this.truncateResultLen);
    if (summary) {
      console.log(`     ${DIM}${summary}${RESET}`);
    }
  }

  toolErr(name: string, errorMsg: string): void {
    console.log(`  ${RED}✘ ${name}${RESET}`);
    console.log(`     ${RED}${truncate(errorMsg, 120)}${RESET}`);
  }

  batchDone(count: number, elapsed: string): void {
    console.log(`  ${DIM}⏱ ${count} tools completed in ${elapsed}${RESET}`);
  }

  answer(text: string | null): void {
    console.log("");
    console.log(BAR);
    console.log(`${BG_GREEN}${BOLD}${WHITE} ANSWER ${RESET}`);
    console.log(BAR);
    console.log(text ?? "(no response)");
  }

  maxIter(max: number): void {
    console.log("");
    console.log(BAR);
    console.log(`${BG_RED}${BOLD}${WHITE} STOPPED — reached ${max} iterations ${RESET}`);
    console.log(BAR);
  }

  // --- Filterable methods ---

  info(message: string): void {
    if (!this.isEnabled("info")) return;
    console.log(`  ${CYAN}ℹ${RESET} ${message}`);
  }

  success(message: string): void {
    // success maps to "info" level for filtering purposes
    if (!this.isEnabled("info")) return;
    console.log(`  ${GREEN}✓${RESET} ${message}`);
  }

  error(message: string): void {
    if (!this.isEnabled("error")) return;
    console.log(`  ${RED}✗${RESET} ${message}`);
  }

  debug(message: string): void {
    if (!this.isEnabled("debug")) return;
    console.log(`  ${DIM}${message}${RESET}`);
  }

  memoryObserve(tokensBefore: number, tokensAfter: number): void {
    console.log(`  ${CYAN}🧠${RESET} Memory observe: ${tokensBefore} → ${tokensAfter} observation tokens`);
  }

  memoryReflect(level: number, tokensBefore: number, tokensAfter: number): void {
    console.log(`  ${CYAN}🧠${RESET} Memory reflect (level ${level}): ${tokensBefore} → ${tokensAfter} tokens`);
  }
}
