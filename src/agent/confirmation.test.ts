import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import type { LLMToolCall } from "../types/llm.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { text } from "../types/tool-result.ts";
import { bus } from "../infra/events.ts";
import { register, reset as resetRegistry } from "../tools/registry.ts";
import {
  confirmBatch,
  clearPendingConfirmations,
  takePendingConfirmation,
} from "./confirmation.ts";
import { WaitRequested } from "./wait-descriptor.ts";

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

  it("throws WaitRequested when a call needs approval", async () => {
    const calls = [
      makeToolCall("c1", "sp76_web__scrape", { urls: ["https://example.com"] }),
      makeToolCall("c2", "sp76_think", {}),
    ];

    let caught: unknown;
    try {
      await confirmBatch(calls);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WaitRequested);
    const waitingOn = (caught as InstanceType<typeof WaitRequested>).waitingOn;
    expect(waitingOn.kind).toBe("user_approval");
    if (waitingOn.kind === "user_approval") {
      expect(waitingOn.confirmationId).toBeDefined();
      expect(waitingOn.prompt).toContain("sp76_web__scrape");
    }
  });

  it("persists pending confirmation so it can be looked up by id", async () => {
    let caught: unknown;
    try {
      await confirmBatch([
        makeToolCall("c1", "sp76_web__scrape", {}),
        makeToolCall("c2", "sp76_bash", {}),
      ]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WaitRequested);
    const waitingOn = (caught as InstanceType<typeof WaitRequested>).waitingOn;
    if (waitingOn.kind !== "user_approval") throw new Error("wrong kind");

    const pending = takePendingConfirmation(waitingOn.confirmationId);
    expect(pending).toBeDefined();
    expect(pending!.requests).toHaveLength(2);
    expect(pending!.toolCalls).toHaveLength(2);
  });

  it("emits confirmation.requested event before throwing", async () => {
    try {
      await confirmBatch([makeToolCall("c1", "sp76_web__scrape", {})]);
    } catch {}

    const requested = emittedEvents.find((e) => e.type === "confirmation.requested");
    expect(requested).toBeDefined();
    expect((requested!.data as any).calls[0].toolName).toBe("sp76_web__scrape");
  });

  it("passes action name not expanded name to confirmIf", async () => {
    // sp76_web's confirmIf returns true only when action === "scrape".
    // For download (no confirmation), no throw should occur.
    const result = await confirmBatch([makeToolCall("c1", "sp76_web__download", {})]);
    expect(result.approved).toHaveLength(1);
    expect(result.denied).toHaveLength(0);
  });
});
