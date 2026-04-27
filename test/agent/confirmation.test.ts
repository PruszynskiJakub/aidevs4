import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import type { LLMToolCall } from "../../src/types/llm.ts";
import type { ToolDefinition } from "../../src/types/tool.ts";
import { text } from "../../src/types/tool-result.ts";
import { bus } from "../../src/infra/events.ts";
import { register, reset as resetRegistry } from "../../src/tools/registry.ts";
import {
  confirmBatch,
  clearPendingConfirmations,
  takePendingConfirmation,
} from "../../src/agent/confirmation.ts";

// Register real test tools — avoids mock.module leakage across test files.
const scrapeTool: ToolDefinition = {
  name: "sp76_web",
  schema: {
    name: "sp76_web",
    description: "Test tool for confirmation",
    actions: {
      scrape: { description: "scrape", schema: z.object({}) },
      download: { description: "download", schema: z.object({}) },
    },
  },
  handler: async () => text("ok"),
  confirmIf: (call) => call.action === "scrape",
};

const thinkTool: ToolDefinition = {
  name: "sp76_think",
  schema: {
    name: "sp76_think",
    description: "think without confirmation",
    schema: z.object({}),
  },
  handler: async () => text("thought"),
};

const bashTool: ToolDefinition = {
  name: "sp76_bash",
  schema: {
    name: "sp76_bash",
    description: "bash always needs confirmation",
    schema: z.object({}),
  },
  handler: async () => text("ran"),
  confirmIf: () => true,
};

beforeAll(() => {
  try { register(scrapeTool); } catch {}
  try { register(thinkTool); } catch {}
  try { register(bashTool); } catch {}
});

function makeToolCall(id: string, name: string, args: Record<string, unknown> = {}): LLMToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

const emittedEvents: Array<{ type: string; data: unknown }> = [];
let busUnsub: (() => void) | null = null;

beforeEach(() => {
  clearPendingConfirmations();
  emittedEvents.length = 0;
  if (busUnsub) busUnsub();
  busUnsub = bus.onAny((e) => {
    emittedEvents.push({ type: e.type, data: e.data });
  });
});

describe("confirmBatch", () => {
  it("auto-approves all calls when no tool needs confirmation", async () => {
    const calls = [makeToolCall("c1", "sp76_think"), makeToolCall("c2", "sp76_think")];
    const result = await confirmBatch(calls);

    expect(result.approved).toHaveLength(2);
    expect(result.denied).toHaveLength(0);
    expect(emittedEvents.some((e) => e.type === "confirmation.requested")).toBe(false);
  });

  it("returns waitingOn when a call needs approval", async () => {
    const calls = [
      makeToolCall("c1", "sp76_web__scrape", { urls: ["https://example.com"] }),
      makeToolCall("c2", "sp76_think", {}),
    ];

    const result = await confirmBatch(calls);

    expect(result.waitingOn).toBeDefined();
    expect(result.waitingOn!.kind).toBe("user_approval");
    if (result.waitingOn!.kind === "user_approval") {
      expect(result.waitingOn!.confirmationId).toBeDefined();
      expect(result.waitingOn!.prompt).toContain("sp76_web__scrape");
    }
    // Auto-approved calls are in the approved list
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0].function.name).toBe("sp76_think");
  });

  it("persists pending confirmation so it can be looked up by id", async () => {
    const result = await confirmBatch([
      makeToolCall("c1", "sp76_web__scrape", {}),
      makeToolCall("c2", "sp76_bash", {}),
    ]);

    expect(result.waitingOn).toBeDefined();
    expect(result.waitingOn!.kind).toBe("user_approval");
    if (result.waitingOn!.kind !== "user_approval") throw new Error("wrong kind");

    const pending = takePendingConfirmation(result.waitingOn!.confirmationId);
    expect(pending).toBeDefined();
    expect(pending!.requests).toHaveLength(2);
    expect(pending!.toolCalls).toHaveLength(2);
  });

  it("passes action name not expanded name to confirmIf", async () => {
    // sp76_web's confirmIf returns true only when action === "scrape".
    // For download (no confirmation), no throw should occur.
    const result = await confirmBatch([makeToolCall("c1", "sp76_web__download", {})]);
    expect(result.approved).toHaveLength(1);
    expect(result.denied).toHaveLength(0);
  });
});
