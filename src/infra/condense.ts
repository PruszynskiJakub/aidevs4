import { llm as defaultLLM } from "../llm/llm.ts";
import { promptService } from "../llm/prompt.ts";
import { files } from "./file.ts";
import { sessionService } from "../agent/session.ts";
import { estimateTokens } from "../utils/tokens.ts";
import type { LLMProvider } from "../types/llm.ts";

const DEFAULT_THRESHOLD = 3_000; // tokens — below this, pass through

export interface CondenseOpts {
  /** Raw tool output text. */
  content: string;
  /** What the tool was trying to accomplish — steers the summary focus. */
  intent: string;
  /** Token threshold before condensing kicks in. Default: 3000. */
  threshold?: number;
  /** Filename hint for the full-output dump. Default: "full-output.txt". */
  filename?: string;
  /** Override LLM provider (for testing). */
  provider?: LLMProvider;
}

export interface CondenseResult {
  /** Either the original content (if small) or the LLM summary. */
  text: string;
  /** Absolute path to the full output file, or null if not condensed. */
  fullPath: string | null;
  /** Whether condensation actually happened. */
  condensed: boolean;
}

/**
 * Condense large tool output into a focused summary.
 *
 * Below the token threshold the content passes through unchanged (zero cost).
 * Above it, the full output is written to a session file and an LLM generates
 * a concise summary that preserves actionable data.
 *
 * Usage inside a tool handler:
 * ```ts
 * const raw = await fetchLargeContent();
 * const { text } = await condense({ content: raw, intent: "Scraped landing page of example.com" });
 * return createDocument(text, description, meta, sessionId);
 * ```
 */
export async function condense(opts: CondenseOpts): Promise<CondenseResult> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const tokens = estimateTokens(opts.content);

  if (tokens <= threshold) {
    return { text: opts.content, fullPath: null, condensed: false };
  }

  // Write full output to session file
  const filename = opts.filename ?? "full-output.txt";
  const fullPath = await sessionService.outputPath(filename);
  await files.write(fullPath, opts.content);
  const relativePath = sessionService.toSessionPath(fullPath);

  // Summarize via LLM
  const provider = opts.provider ?? defaultLLM;
  const prompt = await promptService.load("condense-tool-result", {
    intent: opts.intent,
    content: opts.content,
    full_path: relativePath,
  });

  const summary = await provider.completion({
    model: prompt.model!,
    systemPrompt: prompt.content,
    userPrompt: "Condense the tool output above.",
    temperature: prompt.temperature,
  });

  return { text: summary, fullPath, condensed: true };
}