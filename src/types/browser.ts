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

export interface BrowserInterventions {
  checkScreenshotHint(): string | null;
  checkDiscoveryHint(outcome: "success" | "fail"): string | null;
  checkEndOfTaskHint(): string | null;
}

export interface BrowserSession {
  getPage(): Promise<import("playwright").Page>;
  saveSession(): Promise<void>;
  close(): Promise<void>;
  isRunning(): boolean;
  readonly feedbackTracker: BrowserFeedbackTracker;
  readonly interventions: BrowserInterventions;
}

export interface BrowserPool {
  /** Look up (or create) the browser session keyed by `sessionId`. */
  get(sessionId: string): BrowserSession;
  close(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
  /** @internal — number of active sessions in the pool */
  size(): number;
}
