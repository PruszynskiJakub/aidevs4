import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { LLMToolCall } from "../types/llm.ts";
import type { ToolAnnotations } from "../types/tool.ts";

// Mock the registry to control getToolMeta
let mockToolMeta: Record<string, { annotations?: ToolAnnotations; confirmIf?: (call: { action: string; args: Record<string, unknown>; toolCallId: string }) => boolean }> = {};

mock.module("../tools/registry.ts", () => ({
  SEPARATOR: "__",
  getToolMeta: (expandedName: string) => mockToolMeta[expandedName] ?? mockToolMeta[expandedName.split("__")[0]] ?? undefined,
}));

// Mock the event bus
const emittedEvents: Array<{ type: string; data: unknown }> = [];
mock.module("../infra/events.ts", () => ({
  bus: {
    emit: (type: string, data: unknown) => { emittedEvents.push({ type, data }); },
    on: () => () => {},
    onAny: () => () => {},
    off: () => {},
    offAny: () => {},
    clear: () => {},
  },
}));

const { confirmBatch, setConfirmationProvider, clearConfirmationProvider } = await import("./confirmation.ts");
import type { ConfirmationProvider, ConfirmationRequest } from "./confirmation.ts";

function makeToolCall(id: string, name: string, args: Record<string, unknown> = {}): LLMToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

beforeEach(() => {
  clearConfirmationProvider();
  mockToolMeta = {};
  emittedEvents.length = 0;
});

describe("confirmBatch", () => {
  it("auto-approves all calls when no provider is set", async () => {
    const calls = [makeToolCall("c1", "think"), makeToolCall("c2", "bash")];
    const result = await confirmBatch(calls);

    expect(result.approved).toHaveLength(2);
    expect(result.denied).toHaveLength(0);
    expect(emittedEvents).toHaveLength(0);
  });

  it("auto-approves when no calls have confirmIf", async () => {
    setConfirmationProvider({
      async confirm() { throw new Error("should not be called"); },
    });

    const calls = [makeToolCall("c1", "think"), makeToolCall("c2", "bash")];
    const result = await confirmBatch(calls);

    expect(result.approved).toHaveLength(2);
    expect(result.denied).toHaveLength(0);
  });

  it("calls provider for flagged calls and approves on approve decision", async () => {
    mockToolMeta["web"] = {
      confirmIf: (call) => call.action === "scrape",
    };

    const receivedRequests: ConfirmationRequest[] = [];
    setConfirmationProvider({
      async confirm(requests) {
        receivedRequests.push(...requests);
        return new Map(requests.map((r) => [r.toolCallId, "approve" as const]));
      },
    });

    const calls = [
      makeToolCall("c1", "web__scrape", { urls: ["https://example.com"] }),
      makeToolCall("c2", "think", {}),
    ];

    const result = await confirmBatch(calls);

    expect(result.approved).toHaveLength(2);
    expect(result.denied).toHaveLength(0);
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].toolName).toBe("web__scrape");
  });

  it("denies calls when provider returns deny", async () => {
    mockToolMeta["web"] = {
      confirmIf: (call) => call.action === "scrape",
    };

    setConfirmationProvider({
      async confirm(requests) {
        return new Map(requests.map((r) => [r.toolCallId, "deny" as const]));
      },
    });

    const calls = [
      makeToolCall("c1", "web__scrape", { urls: ["https://example.com"] }),
      makeToolCall("c2", "think", {}),
    ];

    const result = await confirmBatch(calls);

    expect(result.approved).toHaveLength(1);
    expect(result.approved[0].id).toBe("c2");
    expect(result.denied).toHaveLength(1);
    expect(result.denied[0].call.id).toBe("c1");
    expect(result.denied[0].reason).toBe("Denied by operator");
  });

  it("handles mixed batch — approve some, deny others", async () => {
    mockToolMeta["web"] = {
      confirmIf: () => true,
    };

    setConfirmationProvider({
      async confirm(requests) {
        const decisions = new Map<string, "approve" | "deny">();
        for (const r of requests) {
          decisions.set(r.toolCallId, r.toolName.includes("scrape") ? "approve" : "deny");
        }
        return decisions;
      },
    });

    const calls = [
      makeToolCall("c1", "web__scrape", {}),
      makeToolCall("c2", "web__download", {}),
    ];

    const result = await confirmBatch(calls);

    expect(result.approved).toHaveLength(1);
    expect(result.approved[0].id).toBe("c1");
    expect(result.denied).toHaveLength(1);
    expect(result.denied[0].call.id).toBe("c2");
  });

  it("defaults to deny when provider omits a toolCallId from results", async () => {
    mockToolMeta["web"] = {
      confirmIf: (call) => call.action === "scrape",
    };

    setConfirmationProvider({
      async confirm() {
        return new Map(); // returns empty — no decisions
      },
    });

    const calls = [makeToolCall("c1", "web__scrape", {})];
    const result = await confirmBatch(calls);

    expect(result.denied).toHaveLength(1);
    expect(result.denied[0].call.id).toBe("c1");
  });

  it("denies all pending calls when provider throws", async () => {
    mockToolMeta["web"] = {
      confirmIf: (call) => call.action === "scrape",
    };

    setConfirmationProvider({
      async confirm() { throw new Error("provider crashed"); },
    });

    const calls = [
      makeToolCall("c1", "web__scrape", {}),
      makeToolCall("c2", "think", {}),
    ];

    const result = await confirmBatch(calls);

    // think is auto-approved (no confirmIf), scrape is denied due to provider error
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0].id).toBe("c2");
    expect(result.denied).toHaveLength(1);
    expect(result.denied[0].call.id).toBe("c1");
  });

  it("emits confirmation.requested and confirmation.resolved events", async () => {
    mockToolMeta["web"] = {
      confirmIf: (call) => call.action === "scrape",
    };

    setConfirmationProvider({
      async confirm(requests) {
        return new Map(requests.map((r) => [r.toolCallId, "approve" as const]));
      },
    });

    const calls = [makeToolCall("c1", "web__scrape", {})];
    await confirmBatch(calls);

    expect(emittedEvents).toHaveLength(2);
    expect(emittedEvents[0].type).toBe("confirmation.requested");
    expect((emittedEvents[0].data as any).calls[0].toolName).toBe("web__scrape");
    expect(emittedEvents[1].type).toBe("confirmation.resolved");
    expect((emittedEvents[1].data as any).approved).toContain("c1");
  });

  it("passes action name not expanded name to confirmIf", async () => {
    let receivedAction: string | undefined;
    mockToolMeta["web"] = {
      confirmIf: (call) => { receivedAction = call.action; return true; },
    };

    setConfirmationProvider({
      async confirm(requests) {
        return new Map(requests.map((r) => [r.toolCallId, "approve" as const]));
      },
    });

    await confirmBatch([makeToolCall("c1", "web__scrape", {})]);
    expect(receivedAction).toBe("scrape");
  });

  it("passes tool name as action for simple (non-multi-action) tools", async () => {
    let receivedAction: string | undefined;
    mockToolMeta["bash"] = {
      confirmIf: (call) => { receivedAction = call.action; return true; },
    };

    setConfirmationProvider({
      async confirm(requests) {
        return new Map(requests.map((r) => [r.toolCallId, "approve" as const]));
      },
    });

    await confirmBatch([makeToolCall("c1", "bash", {})]);
    expect(receivedAction).toBe("bash");
  });
});
