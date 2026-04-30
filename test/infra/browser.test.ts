import { describe, it, expect, afterEach, mock } from "bun:test";
import { _setBrowserPoolForTest, type BrowserPool, type BrowserSession } from "../../apps/server/src/infra/browser.ts";
import { createBrowserFeedbackTracker } from "../../apps/server/src/infra/browser-feedback.ts";
import { createBrowserInterventions } from "../../apps/server/src/infra/browser-interventions.ts";

function createMockSession(overrides?: Partial<BrowserSession>): BrowserSession {
  let running = false;
  const tracker = createBrowserFeedbackTracker();
  const interventions = createBrowserInterventions(tracker);

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
    feedbackTracker: tracker,
    interventions,
    ...overrides,
  };
}

function createMockPool(opts?: { maxSize?: number }): BrowserPool & { _sessions: Map<string, BrowserSession> } {
  const sessions = new Map<string, BrowserSession>();
  const maxSize = opts?.maxSize ?? 3;

  return {
    _sessions: sessions,
    get(): BrowserSession {
      // In tests, we use a fixed session ID instead of a loop-built RunCtx.
      const sessionId = "test-session";
      const existing = sessions.get(sessionId);
      if (existing) return existing;

      if (sessions.size >= maxSize) {
        throw new Error(`Browser pool full (max ${maxSize}). Close an existing session first.`);
      }

      const session = createMockSession();
      sessions.set(sessionId, session);
      return session;
    },
    async close(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.delete(sessionId);
      await session.close();
    },
    async closeAll() {
      const entries = [...sessions.entries()];
      sessions.clear();
      await Promise.allSettled(entries.map(([, s]) => s.close()));
    },
    size() {
      return sessions.size;
    },
  };
}

describe("BrowserPool", () => {
  let restore: () => void;

  afterEach(() => {
    if (restore) restore();
  });

  it("get() returns a BrowserSession with feedbackTracker and interventions", () => {
    const pool = createMockPool();
    restore = _setBrowserPoolForTest(pool);

    const session = pool.get();
    expect(session).toBeDefined();
    expect(session.feedbackTracker).toBeDefined();
    expect(session.interventions).toBeDefined();
  });

  it("get() returns same instance for same sessionId", () => {
    const pool = createMockPool();
    restore = _setBrowserPoolForTest(pool);

    const s1 = pool.get();
    const s2 = pool.get();
    expect(s1).toBe(s2);
  });

  it("get() returns different instances for different sessionIds", () => {
    const sessions = new Map<string, BrowserSession>();
    let nextId = "session-a";
    const pool: BrowserPool = {
      get() {
        const id = nextId;
        if (!sessions.has(id)) {
          sessions.set(id, createMockSession());
        }
        return sessions.get(id)!;
      },
      async close(id) { sessions.delete(id); },
      async closeAll() { sessions.clear(); },
      size() { return sessions.size; },
    };
    restore = _setBrowserPoolForTest(pool);

    const s1 = pool.get(); // session-a
    nextId = "session-b";
    const s2 = pool.get(); // session-b
    expect(s1).not.toBe(s2);
    expect(pool.size()).toBe(2);
  });

  it("close() removes session and calls session.close()", async () => {
    const pool = createMockPool();
    restore = _setBrowserPoolForTest(pool);

    const session = pool.get();
    await session.getPage();
    expect(session.isRunning()).toBe(true);
    expect(pool.size()).toBe(1);

    await pool.close("test-session");
    expect(pool.size()).toBe(0);
    expect(session.isRunning()).toBe(false);
  });

  it("closeAll() closes all sessions", async () => {
    const sessions = new Map<string, BrowserSession>();
    let counter = 0;
    const pool: BrowserPool = {
      get() {
        const id = `s-${counter++}`;
        const s = createMockSession();
        sessions.set(id, s);
        return s;
      },
      async close(id) {
        const s = sessions.get(id);
        if (s) { await s.close(); sessions.delete(id); }
      },
      async closeAll() {
        await Promise.allSettled([...sessions.values()].map((s) => s.close()));
        sessions.clear();
      },
      size() { return sessions.size; },
    };
    restore = _setBrowserPoolForTest(pool);

    const s1 = pool.get();
    const s2 = pool.get();
    await s1.getPage();
    await s2.getPage();
    expect(pool.size()).toBe(2);

    await pool.closeAll();
    expect(pool.size()).toBe(0);
  });

  it("get() after close() creates a new instance", async () => {
    const pool = createMockPool();
    restore = _setBrowserPoolForTest(pool);

    const s1 = pool.get();
    await pool.close("test-session");
    expect(pool.size()).toBe(0);

    const s2 = pool.get();
    expect(s2).not.toBe(s1);
    expect(pool.size()).toBe(1);
  });

  it("get() throws when pool is at max capacity", () => {
    // Pool with max 1
    const sessions = new Map<string, BrowserSession>();
    const pool: BrowserPool = {
      get() {
        if (sessions.size >= 1) {
          throw new Error("Browser pool full (max 1). Close an existing session first.");
        }
        const s = createMockSession();
        sessions.set("existing", s);
        return s;
      },
      async close(id) { sessions.delete(id); },
      async closeAll() { sessions.clear(); },
      size() { return sessions.size; },
    };
    restore = _setBrowserPoolForTest(pool);

    pool.get(); // fills the pool
    expect(() => pool.get()).toThrow("Browser pool full");
  });

  it("_setBrowserPoolForTest restores original on cleanup", () => {
    const pool1 = createMockPool();
    const pool2 = createMockPool();

    const restore1 = _setBrowserPoolForTest(pool1);
    const restore2 = _setBrowserPoolForTest(pool2);

    restore2();
    restore = restore1;
  });

  it("session close() is idempotent", async () => {
    const session = createMockSession();
    await session.getPage();
    await session.close();
    expect(session.isRunning()).toBe(false);
    await session.close(); // should not throw
    expect(session.isRunning()).toBe(false);
  });
});
