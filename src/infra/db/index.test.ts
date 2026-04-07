import { describe, it, expect, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import * as dbOps from "./index.ts";
import { messagesToItems, itemsToMessages } from "../../agent/session.ts";
import type { LLMMessage } from "../../types/llm.ts";

beforeEach(() => {
  dbOps._clearAll();
});

describe("sessions", () => {
  it("creates and retrieves a session", () => {
    dbOps.createSession("s1");
    const session = dbOps.getSession("s1");
    expect(session).not.toBeNull();
    expect(session!.id).toBe("s1");
    expect(session!.createdAt).toBeTruthy();
  });

  it("returns null for nonexistent session", () => {
    expect(dbOps.getSession("nope")).toBeNull();
  });

  it("touchSession updates updatedAt", async () => {
    dbOps.createSession("s-touch");
    const before = dbOps.getSession("s-touch")!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    dbOps.touchSession("s-touch");
    const after = dbOps.getSession("s-touch")!.updatedAt;
    expect(after > before).toBe(true);
  });

  it("setRootAgent updates the session", () => {
    dbOps.createSession("s-root");
    dbOps.setRootAgent("s-root", "agent-1");
    const session = dbOps.getSession("s-root");
    expect(session!.rootAgentId).toBe("agent-1");
  });

  it("setAssistant updates the session", () => {
    dbOps.createSession("s-asst");
    dbOps.setAssistant("s-asst", "proxy");
    const session = dbOps.getSession("s-asst");
    expect(session!.assistant).toBe("proxy");
  });
});

describe("agents", () => {
  it("creates and retrieves an agent", () => {
    dbOps.createSession("s1");
    dbOps.createAgent({
      id: "a1",
      sessionId: "s1",
      template: "default",
      task: "test task",
    });
    const agent = dbOps.getAgent("a1");
    expect(agent).not.toBeNull();
    expect(agent!.sessionId).toBe("s1");
    expect(agent!.template).toBe("default");
    expect(agent!.status).toBe("pending");
  });

  it("persists parent-child hierarchy", () => {
    dbOps.createSession("s-hier");
    dbOps.createAgent({ id: "parent", sessionId: "s-hier", template: "default", task: "parent task" });
    dbOps.createAgent({
      id: "child",
      sessionId: "s-hier",
      parentId: "parent",
      sourceCallId: "call-123",
      template: "researcher",
      task: "child task",
    });

    const child = dbOps.getAgent("child")!;
    expect(child.parentId).toBe("parent");
    expect(child.sourceCallId).toBe("call-123");

    const agents = dbOps.listAgentsBySession("s-hier");
    expect(agents).toHaveLength(2);
  });

  it("updateAgentStatus transitions correctly", () => {
    dbOps.createSession("s-status");
    dbOps.createAgent({ id: "a-status", sessionId: "s-status", template: "default", task: "t" });

    dbOps.updateAgentStatus("a-status", "running");
    expect(dbOps.getAgent("a-status")!.status).toBe("running");
    expect(dbOps.getAgent("a-status")!.startedAt).toBeTruthy();

    dbOps.updateAgentStatus("a-status", "completed", "done");
    const completed = dbOps.getAgent("a-status")!;
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("done");
    expect(completed.completedAt).toBeTruthy();
  });

  it("updateAgentStatus records error on failure", () => {
    dbOps.createSession("s-fail");
    dbOps.createAgent({ id: "a-fail", sessionId: "s-fail", template: "default", task: "t" });
    dbOps.updateAgentStatus("a-fail", "failed", undefined, "boom");
    const agent = dbOps.getAgent("a-fail")!;
    expect(agent.status).toBe("failed");
    expect(agent.error).toBe("boom");
  });

  it("incrementTurnCount increments correctly", () => {
    dbOps.createSession("s-turn");
    dbOps.createAgent({ id: "a-turn", sessionId: "s-turn", template: "default", task: "t" });
    expect(dbOps.getAgent("a-turn")!.turnCount).toBe(0);
    dbOps.incrementTurnCount("a-turn");
    dbOps.incrementTurnCount("a-turn");
    expect(dbOps.getAgent("a-turn")!.turnCount).toBe(2);
  });
});

describe("items", () => {
  const sessionId = "s-items";
  const agentId = "a-items";

  beforeEach(() => {
    dbOps.createSession(sessionId);
    dbOps.createAgent({ id: agentId, sessionId, template: "default", task: "t" });
  });

  it("nextSequence starts at 0 for new agent", () => {
    expect(dbOps.nextSequence(agentId)).toBe(0);
  });

  it("appendItem and listItemsByAgent", () => {
    dbOps.appendItem({
      id: randomUUID(),
      agentId,
      sequence: 0,
      type: "message",
      role: "user",
      content: "hello",
    });
    const items = dbOps.listItemsByAgent(agentId);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe("hello");
  });

  it("appendItems wraps in transaction", () => {
    dbOps.appendItems([
      { id: randomUUID(), agentId, sequence: 0, type: "message", role: "user", content: "a" },
      { id: randomUUID(), agentId, sequence: 1, type: "message", role: "assistant", content: "b" },
      { id: randomUUID(), agentId, sequence: 2, type: "function_call", callId: "c1", name: "tool1", arguments: "{}" },
    ]);
    expect(dbOps.listItemsByAgent(agentId)).toHaveLength(3);
  });

  it("sequence ordering is preserved", () => {
    for (let i = 0; i < 5; i++) {
      dbOps.appendItem({
        id: randomUUID(),
        agentId,
        sequence: i,
        type: "message",
        role: "user",
        content: `msg-${i}`,
      });
    }
    const items = dbOps.listItemsByAgent(agentId);
    expect(items.map((it) => it.sequence)).toEqual([0, 1, 2, 3, 4]);
  });

  it("getItemByCallId returns correct item", () => {
    dbOps.appendItem({
      id: randomUUID(),
      agentId,
      sequence: 0,
      type: "function_call",
      callId: "call-xyz",
      name: "bash",
      arguments: '{"cmd":"ls"}',
    });
    const item = dbOps.getItemByCallId("call-xyz");
    expect(item).not.toBeNull();
    expect(item!.name).toBe("bash");
  });

  it("listItemsBySession joins through agents", () => {
    const agent2 = "a-items-2";
    dbOps.createAgent({ id: agent2, sessionId, template: "default", task: "t2" });

    dbOps.appendItem({ id: randomUUID(), agentId, sequence: 0, type: "message", role: "user", content: "a" });
    dbOps.appendItem({ id: randomUUID(), agentId: agent2, sequence: 0, type: "message", role: "user", content: "b" });

    const all = dbOps.listItemsBySession(sessionId);
    expect(all).toHaveLength(2);
  });
});

describe("message ↔ item round-trip", () => {
  const agentId = "a-roundtrip";

  it("round-trips simple messages", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "do something" },
    ];

    const items = messagesToItems(agentId, messages, 0);
    const restored = itemsToMessages(items);
    expect(restored).toEqual(messages);
  });

  it("round-trips assistant with tool calls", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "compute" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "tc1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
          { id: "tc2", type: "function", function: { name: "read", arguments: '{"path":"/tmp"}' } },
        ],
      },
      { role: "tool", toolCallId: "tc1", content: "file1\nfile2" },
      { role: "tool", toolCallId: "tc2", content: "/tmp contents" },
    ];

    const items = messagesToItems(agentId, messages, 0);
    const restored = itemsToMessages(items);
    expect(restored).toEqual(messages);
  });

  it("round-trips multi-part user content", () => {
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this image" },
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
      },
    ];

    const items = messagesToItems(agentId, messages, 0);
    const restored = itemsToMessages(items);
    expect(restored).toEqual(messages);
  });

  it("skips system messages", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "hi" },
    ];

    const items = messagesToItems(agentId, messages, 0);
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe("user");
  });

  it("handles null assistant content", () => {
    const messages: LLMMessage[] = [
      { role: "assistant", content: null },
    ];

    const items = messagesToItems(agentId, messages, 0);
    const restored = itemsToMessages(items);
    expect(restored).toEqual(messages);
  });
});
