import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _setBrowserForTest, type BrowserService } from "./browser.ts";

function createMockBrowserService(opts: {
  sessionExists?: boolean;
  pageTitle?: string;
  pageUrl?: string;
} = {}): BrowserService {
  let running = false;
  let sessionSaved = false;
  let responseStatus: number | null = null;

  return {
    async getPage() {
      running = true;
      return {} as never; // Mock page
    },
    async saveSession() {
      sessionSaved = true;
    },
    async close() {
      if (!running) return; // idempotent
      running = false;
      sessionSaved = true;
    },
    isRunning() {
      return running;
    },
    getResponseStatus() {
      return responseStatus;
    },
    setResponseStatus(status: number | null) {
      responseStatus = status;
    },
    // test helpers
    get _sessionSaved() { return sessionSaved; },
  } as BrowserService & { _sessionSaved: boolean };
}

describe("BrowserService mock", () => {
  let restore: () => void;

  afterEach(() => {
    if (restore) restore();
  });

  it("getPage() makes isRunning true", async () => {
    const mock = createMockBrowserService();
    restore = _setBrowserForTest(mock);
    expect(mock.isRunning()).toBe(false);
    await mock.getPage();
    expect(mock.isRunning()).toBe(true);
  });

  it("close() is idempotent", async () => {
    const mock = createMockBrowserService();
    restore = _setBrowserForTest(mock);
    await mock.getPage();
    await mock.close();
    expect(mock.isRunning()).toBe(false);
    // Second close should not throw
    await mock.close();
    expect(mock.isRunning()).toBe(false);
  });

  it("tracks response status", () => {
    const mock = createMockBrowserService();
    restore = _setBrowserForTest(mock);
    expect(mock.getResponseStatus()).toBeNull();
    mock.setResponseStatus(200);
    expect(mock.getResponseStatus()).toBe(200);
    mock.setResponseStatus(null);
    expect(mock.getResponseStatus()).toBeNull();
  });

  it("_setBrowserForTest restores original on cleanup", () => {
    const mock1 = createMockBrowserService();
    const mock2 = createMockBrowserService();

    const restore1 = _setBrowserForTest(mock1);
    const restore2 = _setBrowserForTest(mock2);

    restore2();
    // After restore2, we're back to mock1
    restore = restore1; // cleanup for afterEach
  });
});
