import { describe, it, expect } from "bun:test";
import { createBrowserFeedbackTracker } from "../../src/infra/browser-feedback.ts";
import { createBrowserInterventions } from "../../src/infra/browser-interventions.ts";

describe("BrowserInterventions", () => {
  describe("screenshot hint", () => {
    it("does not fire before 2 consecutive failures", () => {
      const tracker = createBrowserFeedbackTracker();
      const interventions = createBrowserInterventions(tracker);

      tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "e" });
      expect(interventions.checkScreenshotHint()).toBeNull();
    });

    it("fires at exactly 2 consecutive failures", () => {
      const tracker = createBrowserFeedbackTracker();
      const interventions = createBrowserInterventions(tracker);

      tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "e" });
      tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "e" });

      const hint = interventions.checkScreenshotHint();
      expect(hint).toContain("2 consecutive failures");
      expect(hint).toContain("screenshot");
    });

    it("fires only once per session", () => {
      const tracker = createBrowserFeedbackTracker();
      const interventions = createBrowserInterventions(tracker);

      tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "e" });
      tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "e" });

      expect(interventions.checkScreenshotHint()).not.toBeNull();

      tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "e" });
      expect(interventions.checkScreenshotHint()).toBeNull();
    });
  });

  describe("discovery hint", () => {
    it("does not fire on first success without prior failures", () => {
      const tracker = createBrowserFeedbackTracker();
      const interventions = createBrowserInterventions(tracker);

      tracker.record({ tool: "browser__click", outcome: "success", args: {} });
      expect(interventions.checkDiscoveryHint("success")).toBeNull();
    });

    it("fires on recovery (success after failure)", () => {
      const tracker = createBrowserFeedbackTracker();
      const interventions = createBrowserInterventions(tracker);

      tracker.record({ tool: "browser__navigate", outcome: "success", args: { url: "https://example.com" } });
      // Mark failure through intervention
      interventions.checkDiscoveryHint("fail");
      tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "e" });

      const hint = interventions.checkDiscoveryHint("success");
      expect(hint).toContain("recovered from earlier failures");
      expect(hint).toContain("example.com-discoveries.md");
    });

    it("fires only once per session", () => {
      const tracker = createBrowserFeedbackTracker();
      const interventions = createBrowserInterventions(tracker);

      interventions.checkDiscoveryHint("fail");
      tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "e" });

      expect(interventions.checkDiscoveryHint("success")).not.toBeNull();
      expect(interventions.checkDiscoveryHint("success")).toBeNull();
    });
  });

  describe("end-of-task hint", () => {
    it("appends when failures occurred but no discovery hint was sent", () => {
      const tracker = createBrowserFeedbackTracker();
      const interventions = createBrowserInterventions(tracker);

      tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "e" });
      tracker.record({ tool: "browser__click", outcome: "success", args: {} });

      const hint = interventions.checkEndOfTaskHint();
      expect(hint).toContain("browser failures");
    });

    it("does not append when discovery hint was already sent", () => {
      const tracker = createBrowserFeedbackTracker();
      const interventions = createBrowserInterventions(tracker);

      // Trigger failure then recovery
      interventions.checkDiscoveryHint("fail");
      tracker.record({ tool: "browser__click", outcome: "fail", args: {}, error: "e" });
      interventions.checkDiscoveryHint("success"); // fires discovery hint

      expect(interventions.checkEndOfTaskHint()).toBeNull();
    });

    it("does not append when there were no failures", () => {
      const tracker = createBrowserFeedbackTracker();
      const interventions = createBrowserInterventions(tracker);

      tracker.record({ tool: "browser__click", outcome: "success", args: {} });
      expect(interventions.checkEndOfTaskHint()).toBeNull();
    });
  });
});
