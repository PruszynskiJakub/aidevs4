import { describe, it, expect } from "bun:test";
import {
  runWithSession,
  getSessionId,
  requireSessionId,
} from "./session-context.ts";

describe("session-context", () => {
  it("returns undefined outside a session", () => {
    expect(getSessionId()).toBeUndefined();
  });

  it("returns sessionId inside runWithSession", async () => {
    await runWithSession("test-123", async () => {
      expect(getSessionId()).toBe("test-123");
    });
  });

  it("requireSessionId throws outside a session", () => {
    expect(() => requireSessionId()).toThrow("No active session context");
  });

  it("requireSessionId returns id inside a session", async () => {
    await runWithSession("abc", async () => {
      expect(requireSessionId()).toBe("abc");
    });
  });

  it("isolates concurrent sessions", async () => {
    const results: string[] = [];

    await Promise.all([
      runWithSession("sess-A", async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(`A:${getSessionId()}`);
      }),
      runWithSession("sess-B", async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(`B:${getSessionId()}`);
      }),
    ]);

    expect(results).toContain("A:sess-A");
    expect(results).toContain("B:sess-B");
  });

  it("restores undefined after session ends", async () => {
    await runWithSession("temp", async () => {
      expect(getSessionId()).toBe("temp");
    });
    expect(getSessionId()).toBeUndefined();
  });
});
