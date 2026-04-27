import { describe, it, expect, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import * as dbOps from "../../../src/infra/db/index.ts";
import { messagesToItems, itemsToMessages } from "../../../src/agent/session.ts";
import type { LLMMessage } from "../../../src/types/llm.ts";

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

  it("setRootRun updates the session", () => {
    dbOps.createSession("s-root");
    dbOps.setRootRun("s-root", "run-1");
    const session = dbOps.getSession("s-root");
    expect(session!.rootRunId).toBe("run-1");
  });

  it("setAssistant updates the session", () => {
    dbOps.createSession("s-asst");
    dbOps.setAssistant("s-asst", "proxy");
    const session = dbOps.getSession("s-asst");
    expect(session!.assistant).toBe("proxy");
  });
});

describe("runs", () => {
  it("creates and retrieves a run", () => {
    dbOps.createSession("s1");
    dbOps.createRun({
      id: "r1",
      sessionId: "s1",
      template: "default",
      task: "test task",
    });
    const run = dbOps.getRun("r1");
    expect(run).not.toBeNull();
    expect(run!.sessionId).toBe("s1");
    expect(run!.template).toBe("default");
    expect(run!.status).toBe("pending");
  });

  it("persists parent-child hierarchy", () => {
    dbOps.createSession("s-hier");
    dbOps.createRun({ id: "parent", sessionId: "s-hier", template: "default", task: "parent task" });
    dbOps.createRun({
      id: "child",
      sessionId: "s-hier",
      parentId: "parent",
      sourceCallId: "call-123",
      template: "researcher",
      task: "child task",
    });

    const child = dbOps.getRun("child")!;
    expect(child.parentId).toBe("parent");
    expect(child.sourceCallId).toBe("call-123");

    const runs = dbOps.listRunsBySession("s-hier");
    expect(runs).toHaveLength(2);
  });

  it("updateRunStatus transitions correctly", () => {
    dbOps.createSession("s-status");
    dbOps.createRun({ id: "r-status", sessionId: "s-status", template: "default", task: "t" });

    dbOps.updateRunStatus("r-status", { status: "running" });
    expect(dbOps.getRun("r-status")!.status).toBe("running");
    expect(dbOps.getRun("r-status")!.startedAt).toBeTruthy();

    dbOps.updateRunStatus("r-status", { status: "completed", result: "done", exitKind: "completed" });
    const completed = dbOps.getRun("r-status")!;
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("done");
    expect(completed.exitKind).toBe("completed");
    expect(completed.completedAt).toBeTruthy();
  });

  it("updateRunStatus records error on failure", () => {
    dbOps.createSession("s-fail");
    dbOps.createRun({ id: "r-fail", sessionId: "s-fail", template: "default", task: "t" });
    dbOps.updateRunStatus("r-fail", { status: "failed", error: "boom", exitKind: "failed" });
    const run = dbOps.getRun("r-fail")!;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("boom");
    expect(run.exitKind).toBe("failed");
  });

  it("updateRunStatus handles waiting state", () => {
    dbOps.createSession("s-wait");
    dbOps.createRun({ id: "r-wait", sessionId: "s-wait", template: "default", task: "t" });
    const waiting = JSON.stringify({ kind: "user_approval", confirmationId: "c1", prompt: "ok?" });
    dbOps.updateRunStatus("r-wait", { status: "waiting", waitingOn: waiting });
    const run = dbOps.getRun("r-wait")!;
    expect(run.status).toBe("waiting");
    expect(run.waitingOn).toBe(waiting);
  });

  it("incrementCycleCount increments correctly", () => {
    dbOps.createSession("s-cyc");
    dbOps.createRun({ id: "r-cyc", sessionId: "s-cyc", template: "default", task: "t" });
    expect(dbOps.getRun("r-cyc")!.cycleCount).toBe(0);
    dbOps.incrementCycleCount("r-cyc");
    dbOps.incrementCycleCount("r-cyc");
    expect(dbOps.getRun("r-cyc")!.cycleCount).toBe(2);
  });
});

describe("items", () => {
  const sessionId = "s-items";
  const runId = "r-items";

  beforeEach(() => {
    dbOps.createSession(sessionId);
    dbOps.createRun({ id: runId, sessionId, template: "default", task: "t" });
  });

  it("nextSequence starts at 0 for new run", () => {
    expect(dbOps.nextSequence(runId)).toBe(0);
  });

  it("appendItem and listItemsByRun", () => {
    dbOps.appendItem({
      id: randomUUID(),
      runId,
      sequence: 0,
      type: "message",
      role: "user",
      content: "hello",
    });
    const items = dbOps.listItemsByRun(runId);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe("hello");
  });

  it("appendItems wraps in transaction", () => {
    dbOps.appendItems([
      { id: randomUUID(), runId, sequence: 0, type: "message", role: "user", content: "a" },
      { id: randomUUID(), runId, sequence: 1, type: "message", role: "assistant", content: "b" },
      { id: randomUUID(), runId, sequence: 2, type: "function_call", callId: "c1", name: "tool1", arguments: "{}" },
    ]);
    expect(dbOps.listItemsByRun(runId)).toHaveLength(3);
  });

  it("sequence ordering is preserved", () => {
    for (let i = 0; i < 5; i++) {
      dbOps.appendItem({
        id: randomUUID(),
        runId,
        sequence: i,
        type: "message",
        role: "user",
        content: `msg-${i}`,
      });
    }
    const items = dbOps.listItemsByRun(runId);
    expect(items.map((it) => it.sequence)).toEqual([0, 1, 2, 3, 4]);
  });

  it("getItemByCallId returns correct item", () => {
    dbOps.appendItem({
      id: randomUUID(),
      runId,
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

  it("listItemsBySession joins through runs", () => {
    const run2 = "r-items-2";
    dbOps.createRun({ id: run2, sessionId, template: "default", task: "t2" });

    dbOps.appendItem({ id: randomUUID(), runId, sequence: 0, type: "message", role: "user", content: "a" });
    dbOps.appendItem({ id: randomUUID(), runId: run2, sequence: 0, type: "message", role: "user", content: "b" });

    const all = dbOps.listItemsBySession(sessionId);
    expect(all).toHaveLength(2);
  });
});

describe("message ↔ item round-trip", () => {
  const runId = "r-roundtrip";

  it("round-trips simple messages", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "do something" },
    ];

    const items = messagesToItems(runId, messages, 0);
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

    const items = messagesToItems(runId, messages, 0);
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

    const items = messagesToItems(runId, messages, 0);
    const restored = itemsToMessages(items);
    expect(restored).toEqual(messages);
  });

  it("skips system messages", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "hi" },
    ];

    const items = messagesToItems(runId, messages, 0);
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe("user");
  });

  it("handles null assistant content", () => {
    const messages: LLMMessage[] = [
      { role: "assistant", content: null },
    ];

    const items = messagesToItems(runId, messages, 0);
    const restored = itemsToMessages(items);
    expect(restored).toEqual(messages);
  });
});
