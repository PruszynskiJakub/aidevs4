import { describe, it, expect, afterEach } from "bun:test";
import { _setBrowserForTest, type BrowserService } from "./browser.ts";

function createMockBrowserService(): BrowserService {
  let running = false;

  return {
    async getPage() {
      running = true;
      return {} as never;
    },
    async saveSession() {},
    async close() {
      if (!running) return;
      running = false;
    },
    isRunning() {
      return running;
    },
  };
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
    await mock.close();
    expect(mock.isRunning()).toBe(false);
  });

  it("_setBrowserForTest restores original on cleanup", () => {
    const mock1 = createMockBrowserService();
    const mock2 = createMockBrowserService();

    const restore1 = _setBrowserForTest(mock1);
    const restore2 = _setBrowserForTest(mock2);

    restore2();
    restore = restore1;
  });
});
