import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../config/index.ts";
import { files } from "./file.ts";

export interface BrowserService {
  getPage(): Promise<Page>;
  saveSession(): Promise<void>;
  close(): Promise<void>;
  isRunning(): boolean;
  getResponseStatus(): number | null;
  setResponseStatus(status: number | null): void;
}

function createBrowserService(): BrowserService {
  let browserInstance: Browser | null = null;
  let contextInstance: BrowserContext | null = null;
  let pageInstance: Page | null = null;
  let lastResponseStatus: number | null = null;

  async function launch(): Promise<Page> {
    const { headless, userAgent, sessionPath } = config.browser;

    browserInstance = await chromium.launch({ headless });

    const contextOptions: Record<string, unknown> = { userAgent };

    // Restore session if exists
    try {
      if (await files.exists(sessionPath)) {
        const sessionData = await files.readText(sessionPath);
        const storageState = JSON.parse(sessionData);
        contextOptions.storageState = storageState;
      }
    } catch {
      // Corrupted session file — start fresh
    }

    contextInstance = await browserInstance.newContext(contextOptions);
    pageInstance = await contextInstance.newPage();
    return pageInstance;
  }

  const svc: BrowserService = {
    async getPage(): Promise<Page> {
      if (pageInstance && !pageInstance.isClosed()) return pageInstance;
      return launch();
    },

    async saveSession(): Promise<void> {
      if (!contextInstance) return;
      try {
        const state = await contextInstance.storageState();
        const dir = config.browser.sessionPath.replace(/\/[^/]+$/, "");
        await files.mkdir(dir);
        await files.write(config.browser.sessionPath, JSON.stringify(state, null, 2));
      } catch {
        // Best-effort session save
      }
    },

    async close(): Promise<void> {
      if (!browserInstance) return;
      await svc.saveSession();
      try {
        await browserInstance.close();
      } catch {
        // Already closed
      }
      browserInstance = null;
      contextInstance = null;
      pageInstance = null;
      lastResponseStatus = null;
    },

    isRunning(): boolean {
      return browserInstance !== null && pageInstance !== null && !pageInstance.isClosed();
    },

    getResponseStatus(): number | null {
      return lastResponseStatus;
    },

    setResponseStatus(status: number | null): void {
      lastResponseStatus = status;
    },
  };

  return svc;
}

export let browser: BrowserService = createBrowserService();

/** @internal Replace the browser singleton for testing. Returns a restore function. */
export function _setBrowserForTest(custom: BrowserService): () => void {
  const prev = browser;
  browser = custom;
  return () => { browser = prev; };
}

// Cleanup on process exit
process.on("beforeExit", async () => {
  if (browser.isRunning()) {
    await browser.close();
  }
});
