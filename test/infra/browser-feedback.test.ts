import { describe, it, expect } from "bun:test";
import { createBrowserFeedbackTracker } from "../../src/infra/browser-feedback.ts";

describe("BrowserFeedbackTracker", () => {
  it("starts with zero stats", () => {
    const tracker = createBrowserFeedbackTracker();
    expect(tracker.stats()).toEqual({ total: 0, successes: 0, failures: 0 });
    expect(tracker.consecutiveFailures()).toBe(0);
    expect(tracker.lastVisitedHostname()).toBeNull();
  });

  it("tracks consecutive failures and resets on success", () => {
    const tracker = createBrowserFeedbackTracker();
    tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "timeout" });
    tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "timeout" });
    expect(tracker.consecutiveFailures()).toBe(2);

    tracker.record({ tool: "browser__click", outcome: "success", args: {} });
    expect(tracker.consecutiveFailures()).toBe(0);
  });

  it("tracks lastVisitedHostname from navigate events", () => {
    const tracker = createBrowserFeedbackTracker();
    tracker.record({ tool: "browser__navigate", outcome: "success", args: { url: "https://example.com/page" } });
    expect(tracker.lastVisitedHostname()).toBe("example.com");

    tracker.record({ tool: "browser__navigate", outcome: "success", args: { url: "https://other.org/" } });
    expect(tracker.lastVisitedHostname()).toBe("other.org");
  });

  it("generates JSON parse hint for JSON errors", () => {
    const tracker = createBrowserFeedbackTracker();
    const hints = tracker.generateHints("browser__click", "fail", "Unexpected token in JSON");
    expect(hints).toContain("Arguments must be valid JSON (no trailing commas, no markdown fences)");
  });

  it("generates click timeout hint", () => {
    const tracker = createBrowserFeedbackTracker();
    const hints = tracker.generateHints("browser__click", "fail", "Timeout 5000ms exceeded waiting for selector");
    expect(hints).toContain("Element may not be visible — try scrolling or use a broader selector");
  });

  it("generates evaluate null hint", () => {
    const tracker = createBrowserFeedbackTracker();
    const hints = tracker.generateHints("browser__evaluate", "fail", "Cannot read properties of null");
    expect(hints).toContain("A querySelector returned null — the expected element is missing");
  });

  it("generates repeated failures hint after 3+ on same tool", () => {
    const tracker = createBrowserFeedbackTracker();
    tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "err1" });
    tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "err2" });
    tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "err3" });

    const hints = tracker.generateHints("browser__click", "fail", "err4");
    expect(hints).toContain("Multiple failures detected — consider a different strategy");
  });

  it("returns no hints on success", () => {
    const tracker = createBrowserFeedbackTracker();
    const hints = tracker.generateHints("browser__click", "success");
    expect(hints).toHaveLength(0);
  });

  it("tracks stats correctly", () => {
    const tracker = createBrowserFeedbackTracker();
    tracker.record({ tool: "browser__click", outcome: "success", args: {} });
    tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "e" });
    tracker.record({ tool: "browser__click", outcome: "success", args: {} });
    expect(tracker.stats()).toEqual({ total: 3, successes: 2, failures: 1 });
  });
});
