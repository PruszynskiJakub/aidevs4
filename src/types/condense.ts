import type { LLMProvider } from "./llm.ts";

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
