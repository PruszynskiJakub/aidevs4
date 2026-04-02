import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { dirname } from "path";
import { config } from "../config/index.ts";
import { files } from "./file.ts";
import { safeParse } from "../utils/parse.ts";

export interface BrowserService {
  getPage(): Promise<Page>;
  saveSession(): Promise<void>;
  close(): Promise<void>;
  isRunning(): boolean;
}

function createBrowserService(): BrowserService {
  let browserInstance: Browser | null = null;
  let contextInstance: BrowserContext | null = null;
  let pageInstance: Page | null = null;

  async function launch(): Promise<Page> {
    const { headless, userAgent, sessionPath } = config.browser;

    browserInstance = await chromium.launch({ headless });

    const contextOptions: Record<string, unknown> = { userAgent };

    try {
      const sessionData = await files.readText(sessionPath);
      contextOptions.storageState = safeParse(sessionData, "browser session");
    } catch {
      // Missing or corrupted session file — start fresh
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
        await files.mkdir(dirname(config.browser.sessionPath));
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
    },

    isRunning(): boolean {
      return browserInstance !== null && pageInstance !== null && !pageInstance.isClosed();
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

async function cleanup() {
  if (browser.isRunning()) await browser.close();
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
