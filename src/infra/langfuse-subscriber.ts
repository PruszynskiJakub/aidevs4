import { context as otelContext, type Context } from "@opentelemetry/api";
import type { EventBus } from "../types/events.ts";
import { isTracingEnabled } from "./tracing.ts";

type Observation = {
  update(attrs: Record<string, unknown>): Observation;
  end(endTime?: unknown): void;
  setTraceIO(attrs: { input?: unknown; output?: unknown }): Observation;
  startObservation(
    name: string,
    attrs?: Record<string, unknown>,
    opts?: { asType?: string },
  ): Observation;
};

interface AgentEntry {
  obs: Observation;
  ctx: Context;
}

type ModerationBuffer =
  | { passed: true; durationMs: number }
  | { passed: false; categories: string[]; categoryScores: Record<string, number> };

type GenerationData = {
  name: string;
  model: string;
  input: unknown[];
  output: unknown;
  usage: { input: number; output: number; total: number };
  startTime: number;
  durationMs: number;
};

// ── Shared helpers ────────────────────────────────────────────

function toDate(epoch: number): Date {
  return new Date(epoch);
}

const TRUNCATE_DEFAULT = 2000;
const TRUNCATE_ANSWER = 5000;

function truncate(s: string, max = TRUNCATE_DEFAULT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [truncated, ${s.length} chars total]`;
}

function nestGeneration(parent: Observation, gen: GenerationData): void {
  const genObs = parent.startObservation(gen.name, {
    model: gen.model,
    input: gen.input,
    startTime: toDate(gen.startTime),
  }, { asType: "generation" });
  genObs.update({
    output: gen.output,
    usageDetails: {
      input: gen.usage.input,
      output: gen.usage.output,
      total: gen.usage.total,
    },
    endTime: toDate(gen.startTime + gen.durationMs),
  });
  genObs.end();
}

// ── Subscriber state ──────────────────────────────────────────

interface SubscriberState {
  agentMap: Map<string, AgentEntry>;
  turnMap: Map<string, Observation>;
  turnStartMap: Map<string, number>;
  toolMap: Map<string, Observation>;
  agentAnswerMap: Map<string, string>;
  memoryMap: Map<string, Observation>;
  pendingModeration: ModerationBuffer | null;

  startObservation: (
    name: string,
    attrs?: Record<string, unknown>,
    opts?: { asType?: string },
  ) => Observation;
  propagateAttributes: (
    attrs: Record<string, unknown>,
    fn: () => void,
  ) => void;
}

function withAgentCtx<T>(state: SubscriberState, runId: string, fn: () => T): T | undefined {
  const entry = state.agentMap.get(runId);
  if (!entry) return undefined;
  return otelContext.with(entry.ctx, fn);
}

function parentFor(state: SubscriberState, runId: string): Observation | undefined {
  return state.turnMap.get(runId) ?? state.agentMap.get(runId)?.obs;
}

function clearAll(state: SubscriberState): void {
  state.agentMap.clear();
  state.turnMap.clear();
  state.turnStartMap.clear();
  state.toolMap.clear();
  state.agentAnswerMap.clear();
  state.memoryMap.clear();
  state.pendingModeration = null;
}

// ── Domain handler groups ─────────────────────────────────────

function attachSessionHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  const unsubs: (() => void)[] = [];

  unsubs.push(
    bus.on("run.started", (e) => {
      const runId = e.runId;
      if (!runId) return;

      const depth = e.depth ?? 0;
      const input = e.userInput;

      if (depth === 0) {
        state.propagateAttributes(
          { sessionId: e.sessionId, traceName: e.assistant },
          () => {
            const obs = state.startObservation(e.assistant, { input }, { asType: "agent" });
            obs.setTraceIO({ input });
            state.agentMap.set(runId, { obs, ctx: otelContext.active() });
            flushModeration(state, obs);
          },
        );
      } else {
        const parentId = e.parentRunId;
        if (!parentId) return;
        withAgentCtx(state, parentId, () => {
          const parentObs = state.agentMap.get(parentId)!.obs;
          const obs = parentObs.startObservation(
            e.assistant,
            { input },
            { asType: "agent" },
          );
          state.agentMap.set(runId, { obs, ctx: otelContext.active() });
        });
      }
    }),
  );

  unsubs.push(
    bus.on("run.completed", (e) => {
      const runId = e.runId;
      if (!runId) return;
      endAgentObs(state, runId, e.reason, e.iterations, e.tokens);
    }),
  );

  unsubs.push(
    bus.on("run.failed", (e) => {
      const runId = e.runId;
      if (!runId) return;
      endAgentObs(state, runId, "error", e.iterations, e.tokens, e.error);
    }),
  );

  return unsubs;
}

function attachTurnHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  const unsubs: (() => void)[] = [];

  unsubs.push(
    bus.on("cycle.started", (e) => {
      const runId = e.runId;
      if (!runId) return;
      const now = Date.now();
      withAgentCtx(state, runId, () => {
        const agentObs = state.agentMap.get(runId)!.obs;
        const turn = agentObs.startObservation(
          `cycle-${e.iteration}`,
          {
            input: { iteration: e.iteration, messageCount: e.messageCount },
            startTime: toDate(now),
          },
        );
        state.turnMap.set(runId, turn);
        state.turnStartMap.set(runId, now);
      });
    }),
  );

  unsubs.push(
    bus.on("cycle.completed", (e) => {
      const runId = e.runId;
      if (!runId) return;
      const turn = state.turnMap.get(runId);
      if (!turn) return;
      turn.update({
        output: { outcome: e.outcome, durationMs: e.durationMs },
        endTime: toDate(Date.now()),
      });
      turn.end();
      state.turnMap.delete(runId);
      state.turnStartMap.delete(runId);
    }),
  );

  return unsubs;
}

function attachGenerationHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  return [
    bus.on("generation.completed", (e) => {
      const runId = e.runId;
      if (!runId) return;
      withAgentCtx(state, runId, () => {
        const parent = parentFor(state, runId);
        if (!parent) return;

        const output = e.output;
        const chatMlOutput: Record<string, unknown> = {
          role: "assistant",
          content: output.content,
        };
        if (output.toolCalls?.length) {
          chatMlOutput.tool_calls = output.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }

        nestGeneration(parent, { ...e, name: `${e.name}-llm`, output: chatMlOutput });
      });
    }),
  ];
}

function attachToolHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  const unsubs: (() => void)[] = [];

  unsubs.push(
    bus.on("tool.called", (e) => {
      const runId = e.runId;
      if (!runId) return;
      withAgentCtx(state, runId, () => {
        const parent = parentFor(state, runId);
        if (!parent) return;
        const toolObs = parent.startObservation(
          e.name,
          { input: e.args, startTime: toDate(e.startTime) },
          { asType: "tool" },
        );
        state.toolMap.set(e.toolCallId, toolObs);
      });
    }),
  );

  unsubs.push(
    bus.on("tool.succeeded", (e) => {
      const toolObs = state.toolMap.get(e.toolCallId);
      if (!toolObs) return;
      toolObs.update({ output: e.result, endTime: toDate(Date.now()) });
      toolObs.end();
      state.toolMap.delete(e.toolCallId);
    }),
  );

  unsubs.push(
    bus.on("tool.failed", (e) => {
      const toolObs = state.toolMap.get(e.toolCallId);
      if (!toolObs) return;
      toolObs.update({
        output: e.error,
        level: "ERROR",
        statusMessage: e.error,
        endTime: toDate(Date.now()),
      });
      toolObs.end();
      state.toolMap.delete(e.toolCallId);
    }),
  );

  return unsubs;
}

function attachAgentAnswerHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  return [
    bus.on("agent.answered", (e) => {
      const runId = e.runId;
      if (!runId) return;
      const entry = state.agentMap.get(runId);
      if (!entry) return;

      const answerText = truncate(e.text ?? "", TRUNCATE_ANSWER);
      state.agentAnswerMap.set(runId, answerText);

      otelContext.with(entry.ctx, () => {
        entry.obs.update({ output: answerText });
        if ((e.depth ?? 0) === 0) {
          entry.obs.setTraceIO({ output: answerText });
        }
      });
    }),
  ];
}

function attachMemoryHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  const unsubs: (() => void)[] = [];

  // observation lifecycle
  unsubs.push(
    bus.on("memory.observation.started", (e) => {
      const runId = e.runId;
      if (!runId) return;
      withAgentCtx(state, runId, () => {
        const parent = parentFor(state, runId);
        if (!parent) return;
        const span = parent.startObservation("memory-observation", {
          input: { tokensBefore: e.tokensBefore },
          startTime: toDate(Date.now()),
        });
        state.memoryMap.set(`${runId}:observation`, span);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.observation.completed", (e) => {
      const runId = e.runId;
      if (!runId) return;
      withAgentCtx(state, runId, () => {
        const span = state.memoryMap.get(`${runId}:observation`);
        if (!span) return;
        nestGeneration(span, e.generation);
        span.update({
          output: { tokensAfter: e.tokensAfter, compression: `${e.tokensBefore} → ${e.tokensAfter}` },
          endTime: toDate(Date.now()),
        });
        span.end();
        state.memoryMap.delete(`${runId}:observation`);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.observation.failed", (e) => {
      const runId = e.runId;
      if (!runId) return;
      const span = state.memoryMap.get(`${runId}:observation`);
      if (!span) return;
      span.update({ level: "ERROR", statusMessage: e.error });
      span.end();
      state.memoryMap.delete(`${runId}:observation`);
    }),
  );

  // reflection lifecycle
  unsubs.push(
    bus.on("memory.reflection.started", (e) => {
      const runId = e.runId;
      if (!runId) return;
      withAgentCtx(state, runId, () => {
        const parent = parentFor(state, runId);
        if (!parent) return;
        const span = parent.startObservation(`memory-reflection-L${e.level}`, {
          input: { level: e.level, tokensBefore: e.tokensBefore },
          startTime: toDate(Date.now()),
        });
        state.memoryMap.set(`${runId}:reflection`, span);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.reflection.completed", (e) => {
      const runId = e.runId;
      if (!runId) return;
      withAgentCtx(state, runId, () => {
        const span = state.memoryMap.get(`${runId}:reflection`);
        if (!span) return;
        for (const gen of e.generations) {
          nestGeneration(span, gen);
        }
        span.update({
          output: { tokensAfter: e.tokensAfter, compression: `${e.tokensBefore} → ${e.tokensAfter}` },
          endTime: toDate(Date.now()),
        });
        span.end();
        state.memoryMap.delete(`${runId}:reflection`);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.reflection.failed", (e) => {
      const runId = e.runId;
      if (!runId) return;
      const span = state.memoryMap.get(`${runId}:reflection`);
      if (!span) return;
      span.update({ level: "ERROR", statusMessage: e.error });
      span.end();
      state.memoryMap.delete(`${runId}:reflection`);
    }),
  );

  return unsubs;
}

function attachModerationHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  return [
    bus.on("input.clean", (e) => {
      state.pendingModeration = { passed: true, durationMs: e.durationMs };
    }),
    bus.on("input.flagged", (e) => {
      state.pendingModeration = {
        passed: false,
        categories: e.categories,
        categoryScores: e.categoryScores,
      };
    }),
  ];
}

// ── Helpers used by multiple handler groups ────────────────────

function flushModeration(state: SubscriberState, agentObs: Observation): void {
  const buf = state.pendingModeration;
  if (!buf) return;
  state.pendingModeration = null;

  const guard = agentObs.startObservation("input-moderation", {
    input: { check: "openai-moderation" },
  }, { asType: "guardrail" });

  if (buf.passed) {
    guard.update({ output: { passed: true }, metadata: { durationMs: buf.durationMs } });
  } else {
    guard.update({
      output: { passed: false, categories: buf.categories },
      level: "WARNING",
      statusMessage: `Flagged: ${buf.categories.join(", ")}`,
      metadata: { categoryScores: buf.categoryScores },
    });
  }
  guard.end();
}

function endAgentObs(
  state: SubscriberState,
  runId: string,
  reason: string,
  iterations: number,
  tokens: { promptTokens: number; completionTokens: number },
  errorMsg?: string,
): void {
  const entry = state.agentMap.get(runId);
  if (!entry) return;

  const turn = state.turnMap.get(runId);
  if (turn) {
    turn.update({ output: { outcome: reason } });
    turn.end();
    state.turnMap.delete(runId);
  }

  const answer = state.agentAnswerMap.get(runId);

  otelContext.with(entry.ctx, () => {
    if (errorMsg) {
      entry.obs.update({ level: "ERROR", statusMessage: errorMsg });
    }
    entry.obs.update({
      output: answer || null,
      metadata: {
        reason,
        iterations,
        totalTokens: { input: tokens.promptTokens, output: tokens.completionTokens, total: tokens.promptTokens + tokens.completionTokens },
      },
      endTime: toDate(Date.now()),
    });
    entry.obs.end();
  });

  state.agentMap.delete(runId);
  state.agentAnswerMap.delete(runId);
  state.memoryMap.delete(`${runId}:observation`);
  state.memoryMap.delete(`${runId}:reflection`);
}

// ── Main entry point ──────────────────────────────────────────

/**
 * Attaches a Langfuse subscriber to the event bus.
 * Maps domain events → Langfuse observations.
 *
 * Key design point: `propagateAttributes` stores sessionId/traceName
 * in OTel context. Child observations must be created within that
 * context (`otelContext.with(ctx, fn)`) or they become orphaned.
 */
export function attachLangfuseSubscriber(bus: EventBus): () => void {
  if (!isTracingEnabled()) return () => {};

  let startObservation: SubscriberState["startObservation"];
  let propagateAttributes: SubscriberState["propagateAttributes"];

  try {
    const tracing = require("@langfuse/tracing");
    startObservation = tracing.startObservation;
    propagateAttributes = tracing.propagateAttributes;
  } catch {
    console.warn("[langfuse] Failed to import @langfuse/tracing");
    return () => {};
  }

  const state: SubscriberState = {
    agentMap: new Map(),
    turnMap: new Map(),
    turnStartMap: new Map(),
    toolMap: new Map(),
    agentAnswerMap: new Map(),
    memoryMap: new Map(),
    pendingModeration: null,
    startObservation,
    propagateAttributes,
  };

  const unsubs = [
    ...attachSessionHandlers(bus, state),
    ...attachTurnHandlers(bus, state),
    ...attachGenerationHandlers(bus, state),
    ...attachToolHandlers(bus, state),
    ...attachAgentAnswerHandlers(bus, state),
    ...attachMemoryHandlers(bus, state),
    ...attachModerationHandlers(bus, state),
  ];

  return () => {
    for (const unsub of unsubs) unsub();
    clearAll(state);
  };
}
