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

export function duration(startMs: number): string {
  const elapsed = (performance.now() - startMs) / 1000;
  return `${elapsed.toFixed(2)}s`;
}

/** Truncate string to maxLen, appending "…" if cut */
function truncate(s: string, maxLen = 120): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

/** Summarize tool arguments: show key=value pairs, truncate long values */
function summarizeArgs(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return truncate(raw, 80);
    const pairs = Object.entries(obj).map(([k, v]) => {
      const val = typeof v === "string"
        ? truncate(v, 50)
        : typeof v === "object"
          ? truncate(JSON.stringify(v), 50)
          : String(v);
      return `${k}: ${val}`;
    });
    return pairs.join(", ");
  } catch {
    return truncate(raw, 80);
  }
}

/** Summarize tool result: show key info, truncate */
function summarizeResult(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return truncate(raw, 100);
    if (obj.error) return `${RED}error: ${obj.error}${RESET}`;
    const pairs = Object.entries(obj)
      .filter(([k]) => k !== "preview" && k !== "content")
      .map(([k, v]) => {
        const val = typeof v === "string"
          ? truncate(v, 40)
          : typeof v === "object"
            ? truncate(JSON.stringify(v), 40)
            : String(v);
        return `${k}: ${val}`;
      });
    const summary = pairs.join(", ");
    return truncate(summary, 120);
  } catch {
    return truncate(raw, 100);
  }
}

export type Log = ReturnType<typeof createLogger>;

export function createLogger(md?: import("./markdown-logger.ts").MarkdownLogger) {
  return {
    step(iter: number, max: number, model: string, msgCount: number) {
      console.log("");
      console.log(BAR);
      console.log(
        `${BOLD}${WHITE} Step ${iter}/${max}${RESET}` +
        `${DIM}  ·  ${model}  ·  ${msgCount} msgs${RESET}`
      );
      console.log(BAR);
      md?.step(iter, max, model, msgCount);
    },

    llm(elapsed: string, tokensIn?: number, tokensOut?: number) {
      const tokenStr = tokensIn != null
        ? `  ${DIM}(${tokensIn} → ${tokensOut} tokens)${RESET}`
        : "";
      console.log(`  ${CYAN}⚡${RESET} LLM responded in ${BOLD}${elapsed}${RESET}${tokenStr}`);
      md?.llm(elapsed, tokensIn, tokensOut);
    },

    toolHeader(count: number) {
      const parallel = count > 1 ? ` in parallel` : "";
      console.log(`  ${YELLOW}🔧 Calling ${count} tool${count > 1 ? "s" : ""}${parallel}:${RESET}`);
      md?.toolHeader(count);
    },

    toolCall(name: string, rawArgs: string) {
      console.log(`     ${DIM}→${RESET} ${BOLD}${name}${RESET}${DIM}(${summarizeArgs(rawArgs)})${RESET}`);
      md?.toolCall(name, rawArgs);
    },

    toolOk(name: string, elapsed: string, rawResult: string, hints?: string[]) {
      console.log(`  ${GREEN}✔ ${name}${RESET} ${DIM}${elapsed}${RESET}`);
      const summary = summarizeResult(rawResult);
      if (summary) {
        console.log(`     ${DIM}${summary}${RESET}`);
      }
      if (hints?.length) {
        for (const hint of hints) {
          console.log(`     ${YELLOW}💡 ${hint}${RESET}`);
        }
      }
      md?.toolOk(name, elapsed, rawResult, hints);
    },

    toolErr(name: string, errorMsg: string) {
      console.log(`  ${RED}✘ ${name}${RESET}`);
      console.log(`     ${RED}${truncate(errorMsg, 120)}${RESET}`);
      md?.toolErr(name, errorMsg);
    },

    batchDone(count: number, elapsed: string) {
      console.log(`  ${DIM}⏱ ${count} tools completed in ${elapsed}${RESET}`);
      md?.batchDone(count, elapsed);
    },

    answer(text: string | null) {
      console.log("");
      console.log(BAR);
      console.log(`${BG_GREEN}${BOLD}${WHITE} ANSWER ${RESET}`);
      console.log(BAR);
      console.log(text ?? "(no response)");
      md?.answer(text);
    },

    maxIter(max: number) {
      console.log("");
      console.log(BAR);
      console.log(`${BG_RED}${BOLD}${WHITE} STOPPED — reached ${max} iterations ${RESET}`);
      console.log(BAR);
      md?.maxIter(max);
    },

    info(message: string) {
      console.log(`  ${CYAN}ℹ${RESET} ${message}`);
    },

    success(message: string) {
      console.log(`  ${GREEN}✓${RESET} ${message}`);
    },

    error(message: string) {
      console.log(`  ${RED}✗${RESET} ${message}`);
    },

    debug(message: string) {
      console.log(`  ${DIM}${message}${RESET}`);
    },
  };
}

export const log: Log = createLogger();
