import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { dirname, join } from "path";
import { config } from "../config/index.ts";
import * as fs from "./fs.ts";
import { safeParse } from "../utils/parse.ts";
import { getSessionId } from "../agent/context.ts";
import type { BrowserFeedbackTracker, BrowserInterventions, BrowserSession, BrowserPool } from "../types/browser.ts";
import { createBrowserFeedbackTracker } from "./browser-feedback.ts";
import { createBrowserInterventions } from "./browser-interventions.ts";
import { DomainError } from "../types/errors.ts";

export type { BrowserSession, BrowserPool } from "../types/browser.ts";

// ── BrowserSession factory ─────────────────────────────────────

function createBrowserSession(): BrowserSession {
  let browserInstance: Browser | null = null;
  let contextInstance: BrowserContext | null = null;
  let pageInstance: Page | null = null;
  let lastActivity = Date.now();

  const tracker = createBrowserFeedbackTracker();
  const interventionsSvc = createBrowserInterventions(tracker);

  async function launch(): Promise<Page> {
    const { headless, userAgent, sessionPath } = config.browser;

    browserInstance = await chromium.launch({ headless });

    const contextOptions: Record<string, unknown> = { userAgent };

    try {
      const sessionData = await fs.readText(sessionPath);
      contextOptions.storageState = safeParse(sessionData, "browser session");
    } catch {
      // Missing or corrupted session file — start fresh
    }

    contextInstance = await browserInstance.newContext(contextOptions);
    pageInstance = await contextInstance.newPage();
    return pageInstance;
  }

  const svc: BrowserSession = {
    async getPage(): Promise<Page> {
      lastActivity = Date.now();
      if (pageInstance && !pageInstance.isClosed()) return pageInstance;
      return launch();
    },

    async saveSession(): Promise<void> {
      if (!contextInstance) return;
      try {
        const state = await contextInstance.storageState();
        const dir = dirname(config.browser.sessionPath);
        await fs.fsMkdir(dir);
        const tmpPath = join(dir, `.session-${Date.now()}.tmp`);
        await fs.write(tmpPath, JSON.stringify(state, null, 2));
        await fs.fsRename(tmpPath, config.browser.sessionPath);
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

    get feedbackTracker() {
      return tracker;
    },

    get interventions() {
      return interventionsSvc;
    },
  };

  // Expose lastActivity for idle checks
  Object.defineProperty(svc, "_lastActivity", {
    get: () => lastActivity,
    enumerable: false,
  });

  return svc;
}

// ── BrowserPool ────────────────────────────────────────────────

function createBrowserPool(): BrowserPool {
  const sessions = new Map<string, BrowserSession>();
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  function startIdleCheck(): void {
    if (idleTimer) return;
    idleTimer = setInterval(async () => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        const lastActivity = (session as any)._lastActivity as number;
        if (now - lastActivity > config.browser.idleTimeout) {
          await pool.close(id);
        }
      }
      if (sessions.size === 0 && idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
    }, 30_000);
    // Don't prevent process exit
    if (idleTimer && typeof idleTimer === "object" && "unref" in idleTimer) {
      (idleTimer as NodeJS.Timeout).unref();
    }
  }

  const pool: BrowserPool = {
    get(sessionId?: string): BrowserSession {
      const id = sessionId ?? getSessionId();
      if (!id) {
        throw new DomainError({ type: "validation", message: "No active session context" });
      }
      const existing = sessions.get(id);
      if (existing) return existing;

      if (sessions.size >= config.browser.maxPoolSize) {
        throw new DomainError({
          type: "capacity",
          message: `Browser pool full (max ${config.browser.maxPoolSize}). Close an existing session first.`,
        });
      }

      const session = createBrowserSession();
      sessions.set(id, session);
      startIdleCheck();
      return session;
    },

    async close(sessionId: string): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.delete(sessionId);
      await session.close();
    },

    async closeAll(): Promise<void> {
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      const entries = [...sessions.entries()];
      sessions.clear();
      await Promise.allSettled(entries.map(([, s]) => s.close()));
    },

    size(): number {
      return sessions.size;
    },
  };

  return pool;
}

// ── Singleton + test override ──────────────────────────────────

export let browserPool: BrowserPool = createBrowserPool();

/** @internal Replace the browser pool singleton for testing. Returns a restore function. */
export function _setBrowserPoolForTest(custom: BrowserPool): () => void {
  const prev = browserPool;
  browserPool = custom;
  return () => { browserPool = prev; };
}

// ── Process cleanup ────────────────────────────────────────────

async function cleanup() {
  await browserPool.closeAll();
}
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
