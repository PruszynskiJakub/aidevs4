import type { BrowserFeedbackTracker } from "./browser-feedback.ts";

export interface BrowserInterventions {
  checkScreenshotHint(): string | null;
  checkDiscoveryHint(outcome: "success" | "fail"): string | null;
  checkEndOfTaskHint(): string | null;
}

export function createBrowserInterventions(tracker: BrowserFeedbackTracker): BrowserInterventions {
  let screenshotHintSent = false;
  let discoveryHintSent = false;
  let hadFailures = false;

  return {
    checkScreenshotHint(): string | null {
      const failures = tracker.consecutiveFailures();
      if (failures >= 1) hadFailures = true;

      if (failures >= 2 && !screenshotHintSent) {
        screenshotHintSent = true;
        return `You've had ${failures} consecutive failures. The page may have changed — consider taking a screenshot to visually inspect the current state before trying another approach.`;
      }
      return null;
    },

    checkDiscoveryHint(outcome: "success" | "fail"): string | null {
      if (outcome === "fail") {
        hadFailures = true;
        return null;
      }

      // Success after previous failures = recovery
      if (hadFailures && !discoveryHintSent) {
        discoveryHintSent = true;
        const hostname = tracker.lastVisitedHostname() ?? "unknown";
        return `You recovered from earlier failures. Consider saving the working approach to workspace/knowledge/browser/${hostname}-discoveries.md so future runs can reuse it.`;
      }
      return null;
    },

    checkEndOfTaskHint(): string | null {
      const { failures } = tracker.stats();
      if (failures > 0 && !discoveryHintSent) {
        return "There were browser failures during this session. Consider saving any learnings to workspace/knowledge/browser/ so future runs can benefit.";
      }
      return null;
    },
  };
}
