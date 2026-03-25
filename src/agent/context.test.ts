import { describe, it, expect } from "bun:test";
import {
  runWithContext,
  getState,
  requireState,
  getLogger,
  requireLogger,
  getSessionId,
  requireSessionId,
} from "./context.ts";
import type { AgentState } from "../types/agent-state.ts";
import type { Logger } from "../types/logger.ts";
import { emptyMemoryState } from "../types/memory.ts";

const noopLogger = new Proxy({} as Logger, { get: () => () => {} });

function makeState(sessionId: string): AgentState {
  return {
    sessionId,
    messages: [],
    tokens: {
      plan: { promptTokens: 0, completionTokens: 0 },
      act: { promptTokens: 0, completionTokens: 0 },
    },
    iteration: 0,
    assistant: "default",
    model: "",
    tools: [],
    memory: emptyMemoryState(),
  };
}

// ── runWithContext / getState / requireState ───────────────────

describe("runWithContext", () => {
  it("makes state available via getState", async () => {
    const state = makeState("ctx-1");
    await runWithContext(state, noopLogger, async () => {
      expect(getState()).toBe(state);
    });
  });

  it("makes logger available via getLogger", async () => {
    const state = makeState("ctx-2");
    await runWithContext(state, noopLogger, async () => {
      expect(getLogger()).toBe(noopLogger);
    });
  });

  it("state mutations are visible", async () => {
    const state = makeState("ctx-3");
    await runWithContext(state, noopLogger, async () => {
      const s = requireState();
      s.iteration = 5;
      s.messages.push({ role: "user", content: "hello" });
    });
    expect(state.iteration).toBe(5);
    expect(state.messages).toHaveLength(1);
  });

  it("isolates concurrent contexts", async () => {
    const results: string[] = [];
    await Promise.all([
      runWithContext(makeState("A"), noopLogger, async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(`A:${requireState().sessionId}`);
      }),
      runWithContext(makeState("B"), noopLogger, async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(`B:${requireState().sessionId}`);
      }),
    ]);
    expect(results).toContain("A:A");
    expect(results).toContain("B:B");
  });

  it("restores undefined after context ends", async () => {
    await runWithContext(makeState("temp"), noopLogger, async () => {
      expect(getState()).toBeDefined();
    });
    expect(getState()).toBeUndefined();
    expect(getLogger()).toBeUndefined();
  });
});

describe("requireState / requireLogger outside context", () => {
  it("requireState throws", () => {
    expect(() => requireState()).toThrow("No active agent state context");
  });

  it("requireLogger throws", () => {
    expect(() => requireLogger()).toThrow("No active logger context");
  });
});

// ── sessionId accessors ───────────────────────────────────────

describe("sessionId accessors", () => {
  it("getSessionId returns undefined outside context", () => {
    expect(getSessionId()).toBeUndefined();
  });

  it("getSessionId returns id inside runWithContext", async () => {
    await runWithContext(makeState("test-123"), noopLogger, async () => {
      expect(getSessionId()).toBe("test-123");
    });
  });

  it("requireSessionId throws outside context", () => {
    expect(() => requireSessionId()).toThrow("No active session context");
  });

  it("requireSessionId returns id inside context", async () => {
    await runWithContext(makeState("abc"), noopLogger, async () => {
      expect(requireSessionId()).toBe("abc");
    });
  });

  it("restores undefined after context ends", async () => {
    await runWithContext(makeState("temp"), noopLogger, async () => {
      expect(getSessionId()).toBe("temp");
    });
    expect(getSessionId()).toBeUndefined();
  });
});
