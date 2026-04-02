export interface FeedbackEvent {
  tool: string;
  outcome: "success" | "fail";
  args: Record<string, unknown>;
  error?: string;
}

export interface BrowserFeedbackTracker {
  record(event: FeedbackEvent): void;
  consecutiveFailures(): number;
  lastVisitedHostname(): string | null;
  generateHints(tool: string, outcome: "success" | "fail", error?: string): string[];
  stats(): { total: number; successes: number; failures: number };
}

export function createBrowserFeedbackTracker(): BrowserFeedbackTracker {
  const history: FeedbackEvent[] = [];
  let consecutive = 0;
  let lastHostname: string | null = null;

  return {
    record(event: FeedbackEvent): void {
      history.push(event);
      if (event.outcome === "fail") {
        consecutive++;
      } else {
        consecutive = 0;
      }

      // Track hostname from navigate actions
      if (event.tool === "browser__navigate" && event.args.url) {
        try {
          lastHostname = new URL(event.args.url as string).hostname;
        } catch {
          // Invalid URL — ignore
        }
      }
    },

    consecutiveFailures(): number {
      return consecutive;
    },

    lastVisitedHostname(): string | null {
      return lastHostname;
    },

    generateHints(tool: string, outcome: "success" | "fail", error?: string): string[] {
      const hints: string[] = [];
      if (outcome !== "fail" || !error) return hints;

      const msg = error.toLowerCase();

      if (msg.includes("json") || msg.includes("trailing comma") || msg.includes("unexpected token")) {
        hints.push("Arguments must be valid JSON (no trailing commas, no markdown fences)");
      }

      if (tool.includes("click") && (msg.includes("timeout") || msg.includes("waiting for"))) {
        hints.push("Element may not be visible — try scrolling or use a broader selector");
      }

      if (tool.includes("evaluate") && (msg.includes("null") || msg.includes("cannot read properties"))) {
        hints.push("A querySelector returned null — the expected element is missing");
      }

      // Check for repeated failures on same tool
      const recentSameTool = history.slice(-4).filter(
        (e) => e.tool === tool && e.outcome === "fail",
      );
      if (recentSameTool.length >= 3) {
        hints.push("Multiple failures detected — consider a different strategy");
      }

      return hints;
    },

    stats() {
      const successes = history.filter((e) => e.outcome === "success").length;
      return {
        total: history.length,
        successes,
        failures: history.length - successes,
      };
    },
  };
}
