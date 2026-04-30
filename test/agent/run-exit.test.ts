import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LLMChatResponse, LLMProvider, LLMToolCall, LLMMessage, LLMAssistantMessage } from "../../apps/server/src/types/llm.ts";
import type { RunState } from "../../apps/server/src/types/run-state.ts";
import type { RunExit } from "../../apps/server/src/agent/run-exit.ts";
import type { WaitResolution } from "../../apps/server/src/types/wait.ts";
import { emptyMemoryState } from "../../apps/server/src/types/memory.ts";

// Install our own stub registry before loading any agent/loop modules.
// This shields us from cross-file `mock.module` contamination that
// replaces registry.ts earlier in the bun-test run.
const testToolState = {
  dispatched: 0,
  returnValue: "test-tool ran",
};

const toolMetaByName: Record<string, { confirmIf?: () => boolean }> = {
  sp87_test_tool: { confirmIf: () => true },
  sp87_noop_tool: {},
};

const toolHandlers: Record<string, () => Promise<{ content: string; isError: boolean }>> = {
  sp87_test_tool: async () => {
    testToolState.dispatched += 1;
    return { content: testToolState.returnValue, isError: false };
  },
  sp87_noop_tool: async () => ({ content: "noop", isError: false }),
};

mock.module("../../apps/server/src/tools/registry.ts", () => ({
  SEPARATOR: "__",
  getToolMeta: (name: string) => toolMetaByName[name],
  dispatch: async (name: string) => {
    const fn = toolHandlers[name];
    if (!fn) return { content: `Error: Unknown tool: ${name}`, isError: true };
    return fn();
  },
  register: () => {},
  registerRaw: () => {},
  getTools: async () => [],
  getToolsByName: () => undefined,
  reset: () => {},
  serializeContent: () => "",
}));

const { runAgent } = await import("../../apps/server/src/agent/loop.ts");
const { sessionService } = await import("../../apps/server/src/agent/session.ts");
const { bus } = await import("../../apps/server/src/infra/events.ts");
const { config } = await import("../../apps/server/src/config/index.ts");
const dbOps = await import("../../apps/server/src/infra/db/index.ts");

// NOTE: we deliberately do NOT import from "../../apps/server/src/agent/orchestrator.ts" in this
// test file. Other test files (`src/tools/delegate.test.ts`) install
// process-wide `mock.module("../../apps/server/src/agent/orchestrator.ts", ...)` stubs, and Bun's
// test runner does not isolate those mocks between files. Instead we
// reimplement the orchestrator's status-persistence wrapper locally so
// the real loop code is exercised end-to-end.

// testToolState / toolHandlers declared above (alongside the registry mock).

// ── Orchestrator-shaped helper (avoids ./orchestrator.ts import) ──

interface ExecuteRunOpts {
  sessionId: string;
  prompt: string;
  assistantName: string;
}

interface LocalRunResult {
  exit: RunExit;
  runId: string;
  sessionId: string;
}

async function runWithLifecycle(state: RunState): Promise<LocalRunResult> {
  const runId = state.runId!;
  try {
    const { exit, messages } = await runAgent(state);
    sessionService.appendRun(state.sessionId, runId, messages);

    switch (exit.kind) {
      case "completed":
        dbOps.updateRunStatus(runId, {
          status: "completed",
          result: exit.result,
          exitKind: "completed",
        });
        break;
      case "failed":
        dbOps.updateRunStatus(runId, {
          status: "failed",
          error: exit.error.message,
          exitKind: "failed",
        });
        break;
      case "cancelled":
        dbOps.updateRunStatus(runId, {
          status: "cancelled",
          error: exit.reason,
          exitKind: "cancelled",
        });
        break;
      case "exhausted":
        dbOps.updateRunStatus(runId, {
          status: "exhausted",
          exitKind: "exhausted",
        });
        break;
      case "waiting":
        dbOps.updateRunStatus(runId, {
          status: "waiting",
          waitingOn: JSON.stringify(exit.waitingOn),
        });
        bus.emit("run.waiting", { waitingOn: exit.waitingOn });
        break;
    }

    return { exit, runId, sessionId: state.sessionId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dbOps.updateRunStatus(runId, {
      status: "failed",
      error: msg,
      exitKind: "failed",
    });
    return {
      exit: { kind: "failed", error: { message: msg } },
      runId,
      sessionId: state.sessionId,
    };
  }
}

/** Local resume helper that mirrors resumeRun without importing it. */
async function localResumeRun(
  runId: string,
  resolution: WaitResolution,
): Promise<LocalRunResult> {
  const run = dbOps.getRun(runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  if (run.status !== "waiting") throw new Error(`Run ${runId} not waiting`);

  const messages = sessionService.getMessages(run.sessionId, runId);
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) answered.add(m.toolCallId);
  }
  const pending = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const asst = m as LLMAssistantMessage;
      if (!asst.toolCalls?.length) continue;
      const p = asst.toolCalls.filter((tc) => !answered.has(tc.id));
      if (p.length > 0) return p;
    }
    return [];
  })();

  const newMessages: LLMMessage[] = [];
  if (resolution.kind === "user_approval") {
    for (const call of pending) {
      const decision = resolution.decisions[call.id] ?? "deny";
      if (decision === "approve") {
        const handler = toolHandlers[call.function.name];
        const result = handler
          ? await handler()
          : { content: `Error: Unknown tool: ${call.function.name}`, isError: true };
        newMessages.push({ role: "tool", toolCallId: call.id, content: result.content });
      } else {
        newMessages.push({
          role: "tool",
          toolCallId: call.id,
          content: "Error: Tool call denied by operator.",
        });
      }
    }
  }

  sessionService.appendRun(run.sessionId, runId, newMessages);
  dbOps.updateRunStatus(runId, { status: "running", waitingOn: null });

  const fullMessages = sessionService.getMessages(run.sessionId, runId);
  const state: RunState = {
    sessionId: run.sessionId,
    agentName: run.template,
    runId,
    rootRunId: runId,
    traceId: randomUUID(),
    depth: 0,
    messages: fullMessages,
    tokens: { promptTokens: 0, completionTokens: 0 },
    iteration: 0,
    assistant: run.template,
    model: "",
    tools: [],
    memory: emptyMemoryState(),
  };

  return runWithLifecycle(state);
}

async function localExecuteRun(
  opts: ExecuteRunOpts,
  provider: LLMProvider,
): Promise<LocalRunResult> {
  const { sessionId, prompt, assistantName } = opts;
  sessionService.getOrCreate(sessionId);
  const runId = randomUUID();
  dbOps.createRun({
    id: runId,
    sessionId,
    template: assistantName,
    task: prompt,
  });
  dbOps.setRootRun(sessionId, runId);
  dbOps.updateRunStatus(runId, { status: "running" });

  sessionService.appendMessage(sessionId, runId, { role: "user", content: prompt });
  const messages: LLMMessage[] = sessionService.getMessages(sessionId, runId);

  const state: RunState = {
    sessionId,
    agentName: assistantName,
    runId,
    rootRunId: runId,
    traceId: randomUUID(),
    depth: 0,
    messages,
    tokens: { promptTokens: 0, completionTokens: 0 },
    iteration: 0,
    assistant: assistantName,
    model: "",
    tools: [],
    memory: emptyMemoryState(),
  };

  // Install our stub LLM provider for the duration of the run.
  const { llm } = await import("../../apps/server/src/llm/llm.ts");
  const holder = llm as unknown as Record<string, unknown>;
  const original = holder.chatCompletion;
  holder.chatCompletion = provider.chatCompletion.bind(provider);
  try {
    return await runWithLifecycle(state);
  } finally {
    holder.chatCompletion = original;
  }
}

function seqProvider(responses: LLMChatResponse[]): LLMProvider {
  let i = 0;
  return {
    chatCompletion: async () => {
      const r = responses[i++];
      if (!r) throw new Error(`seqProvider exhausted at call ${i}`);
      return r;
    },
    completion: async () => "",
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): LLMToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

beforeEach(() => {
  dbOps._clearAll();
  testToolState.dispatched = 0;
  testToolState.returnValue = "test-tool ran";
});

// ── Tests ────────────────────────────────────────────────────

describe("executeRun happy path", () => {
  it("returns { kind: 'completed' } and transitions pending → running → completed", async () => {
    const provider = seqProvider([
      { content: "Hello world", finishReason: "stop", toolCalls: [] },
    ]);

    const result = await localExecuteRun(
      { sessionId: "s-happy-sp87", prompt: "Say hi", assistantName: "default" },
      provider,
    );

    expect(result.exit.kind).toBe("completed");
    if (result.exit.kind === "completed") {
      expect(result.exit.result).toBe("Hello world");
    }

    const run = dbOps.getRun(result.runId)!;
    expect(run.status).toBe("completed");
    expect(run.exitKind).toBe("completed");
    expect(run.result).toBe("Hello world");
    expect(run.startedAt).toBeTruthy();
    expect(run.completedAt).toBeTruthy();
  });
});

describe("executeRun HITL cycle", () => {
  it("returns 'waiting' then resumes to 'completed'; DB row transitions running → waiting → running → completed", async () => {
    const provider = seqProvider([
      {
        content: null,
        finishReason: "tool_calls",
        toolCalls: [toolCall("tc-1", "sp87_test_tool")],
      },
      {
        content: "Did the thing",
        finishReason: "stop",
        toolCalls: [],
      },
    ]);

    // Install the provider for both runAgent calls (initial + resume).
    const { llm } = await import("../../apps/server/src/llm/llm.ts");
    const holder = llm as unknown as Record<string, unknown>;
    const original = holder.chatCompletion;
    holder.chatCompletion = provider.chatCompletion.bind(provider);

    try {
      const first = await localExecuteRun(
        { sessionId: "s-hitl-sp87", prompt: "Do the thing", assistantName: "default" },
        provider,
      );

      expect(first.exit.kind).toBe("waiting");
      const waitingRun = dbOps.getRun(first.runId)!;
      expect(waitingRun.status).toBe("waiting");
      expect(waitingRun.waitingOn).toBeTruthy();

      if (first.exit.kind !== "waiting") throw new Error("expected waiting");
      if (first.exit.waitingOn.kind !== "user_approval") throw new Error("wrong kind");

      const resumed = await localResumeRun(first.runId, {
        kind: "user_approval",
        confirmationId: first.exit.waitingOn.confirmationId,
        decisions: { "tc-1": "approve" },
      });

      expect(resumed.exit.kind).toBe("completed");
      if (resumed.exit.kind === "completed") {
        expect(resumed.exit.result).toBe("Did the thing");
      }
      expect(testToolState.dispatched).toBe(1);

      const finalRun = dbOps.getRun(first.runId)!;
      expect(finalRun.status).toBe("completed");
      expect(finalRun.exitKind).toBe("completed");
      expect(finalRun.waitingOn).toBeNull();
    } finally {
      holder.chatCompletion = original;
    }
  });
});

describe("executeRun loop exhaustion", () => {
  it("returns { kind: 'exhausted', cycleCount } with DB status=exhausted", async () => {
    const maxIter = config.limits.maxIterations;

    const neverEnding: LLMChatResponse[] = [];
    for (let i = 0; i < maxIter + 5; i++) {
      neverEnding.push({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [toolCall(`tc-${i}`, "sp87_noop_tool")],
      });
    }

    const result = await localExecuteRun(
      { sessionId: "s-exhaust-sp87", prompt: "Keep going", assistantName: "default" },
      seqProvider(neverEnding),
    );

    expect(result.exit.kind).toBe("exhausted");
    if (result.exit.kind === "exhausted") {
      expect(result.exit.cycleCount).toBe(maxIter);
    }

    const run = dbOps.getRun(result.runId)!;
    expect(run.status).toBe("exhausted");
    expect(run.exitKind).toBe("exhausted");
    expect(run.cycleCount).toBe(maxIter);
  }, 30_000);
});
