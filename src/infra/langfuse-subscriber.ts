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

function withAgentCtx<T>(state: SubscriberState, agentId: string, fn: () => T): T | undefined {
  const entry = state.agentMap.get(agentId);
  if (!entry) return undefined;
  return otelContext.with(entry.ctx, fn);
}

function parentFor(state: SubscriberState, agentId: string): Observation | undefined {
  return state.turnMap.get(agentId) ?? state.agentMap.get(agentId)?.obs;
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
    bus.on("session.opened", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;

      const depth = e.depth ?? 0;
      const input = e.data.userInput;

      if (depth === 0) {
        state.propagateAttributes(
          { sessionId: e.sessionId, traceName: e.data.assistant },
          () => {
            const obs = state.startObservation(e.data.assistant, { input }, { asType: "agent" });
            obs.setTraceIO({ input });
            state.agentMap.set(agentId, { obs, ctx: otelContext.active() });
            flushModeration(state, obs);
          },
        );
      } else {
        const parentId = e.parentAgentId;
        if (!parentId) return;
        withAgentCtx(state, parentId, () => {
          const parentObs = state.agentMap.get(parentId)!.obs;
          const obs = parentObs.startObservation(
            e.data.assistant,
            { input },
            { asType: "agent" },
          );
          state.agentMap.set(agentId, { obs, ctx: otelContext.active() });
        });
      }
    }),
  );

  unsubs.push(
    bus.on("session.completed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      endAgentObs(state, agentId, e.data.reason, e.data.iterations, e.data.tokens);
    }),
  );

  unsubs.push(
    bus.on("session.failed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      endAgentObs(state, agentId, "error", e.data.iterations, e.data.tokens, e.data.error);
    }),
  );

  return unsubs;
}

function attachTurnHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  const unsubs: (() => void)[] = [];

  unsubs.push(
    bus.on("turn.started", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const now = Date.now();
      withAgentCtx(state, agentId, () => {
        const agentObs = state.agentMap.get(agentId)!.obs;
        const turn = agentObs.startObservation(
          `turn-${e.data.iteration}`,
          {
            input: { iteration: e.data.iteration, messageCount: e.data.messageCount },
            startTime: toDate(now),
          },
        );
        state.turnMap.set(agentId, turn);
        state.turnStartMap.set(agentId, now);
      });
    }),
  );

  unsubs.push(
    bus.on("turn.completed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const turn = state.turnMap.get(agentId);
      if (!turn) return;
      turn.update({
        output: { outcome: e.data.outcome, durationMs: e.data.durationMs },
        endTime: toDate(Date.now()),
      });
      turn.end();
      state.turnMap.delete(agentId);
      state.turnStartMap.delete(agentId);
    }),
  );

  return unsubs;
}

function attachGenerationHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  return [
    bus.on("generation.completed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(state, agentId, () => {
        const parent = parentFor(state, agentId);
        if (!parent) return;

        const output = e.data.output;
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

        nestGeneration(parent, { ...e.data, name: `${e.data.name}-llm`, output: chatMlOutput });
      });
    }),
  ];
}

function attachToolHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  const unsubs: (() => void)[] = [];

  unsubs.push(
    bus.on("tool.called", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(state, agentId, () => {
        const parent = parentFor(state, agentId);
        if (!parent) return;
        const toolObs = parent.startObservation(
          e.data.name,
          { input: e.data.args, startTime: toDate(e.data.startTime) },
          { asType: "tool" },
        );
        state.toolMap.set(e.data.toolCallId, toolObs);
      });
    }),
  );

  unsubs.push(
    bus.on("tool.succeeded", (e) => {
      const toolObs = state.toolMap.get(e.data.toolCallId);
      if (!toolObs) return;
      toolObs.update({ output: e.data.result, endTime: toDate(Date.now()) });
      toolObs.end();
      state.toolMap.delete(e.data.toolCallId);
    }),
  );

  unsubs.push(
    bus.on("tool.failed", (e) => {
      const toolObs = state.toolMap.get(e.data.toolCallId);
      if (!toolObs) return;
      toolObs.update({
        output: e.data.error,
        level: "ERROR",
        statusMessage: e.data.error,
        endTime: toDate(Date.now()),
      });
      toolObs.end();
      state.toolMap.delete(e.data.toolCallId);
    }),
  );

  return unsubs;
}

function attachAgentAnswerHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  return [
    bus.on("agent.answered", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const entry = state.agentMap.get(agentId);
      if (!entry) return;

      const answerText = truncate(e.data.text ?? "", TRUNCATE_ANSWER);
      state.agentAnswerMap.set(agentId, answerText);

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
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(state, agentId, () => {
        const parent = parentFor(state, agentId);
        if (!parent) return;
        const span = parent.startObservation("memory-observation", {
          input: { tokensBefore: e.data.tokensBefore },
          startTime: toDate(Date.now()),
        });
        state.memoryMap.set(`${agentId}:observation`, span);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.observation.completed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(state, agentId, () => {
        const span = state.memoryMap.get(`${agentId}:observation`);
        if (!span) return;
        nestGeneration(span, e.data.generation);
        span.update({
          output: { tokensAfter: e.data.tokensAfter, compression: `${e.data.tokensBefore} → ${e.data.tokensAfter}` },
          endTime: toDate(Date.now()),
        });
        span.end();
        state.memoryMap.delete(`${agentId}:observation`);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.observation.failed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const span = state.memoryMap.get(`${agentId}:observation`);
      if (!span) return;
      span.update({ level: "ERROR", statusMessage: e.data.error });
      span.end();
      state.memoryMap.delete(`${agentId}:observation`);
    }),
  );

  // reflection lifecycle
  unsubs.push(
    bus.on("memory.reflection.started", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(state, agentId, () => {
        const parent = parentFor(state, agentId);
        if (!parent) return;
        const span = parent.startObservation(`memory-reflection-L${e.data.level}`, {
          input: { level: e.data.level, tokensBefore: e.data.tokensBefore },
          startTime: toDate(Date.now()),
        });
        state.memoryMap.set(`${agentId}:reflection`, span);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.reflection.completed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(state, agentId, () => {
        const span = state.memoryMap.get(`${agentId}:reflection`);
        if (!span) return;
        for (const gen of e.data.generations) {
          nestGeneration(span, gen);
        }
        span.update({
          output: { tokensAfter: e.data.tokensAfter, compression: `${e.data.tokensBefore} → ${e.data.tokensAfter}` },
          endTime: toDate(Date.now()),
        });
        span.end();
        state.memoryMap.delete(`${agentId}:reflection`);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.reflection.failed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const span = state.memoryMap.get(`${agentId}:reflection`);
      if (!span) return;
      span.update({ level: "ERROR", statusMessage: e.data.error });
      span.end();
      state.memoryMap.delete(`${agentId}:reflection`);
    }),
  );

  return unsubs;
}

function attachModerationHandlers(bus: EventBus, state: SubscriberState): (() => void)[] {
  return [
    bus.on("input.clean", (e) => {
      state.pendingModeration = { passed: true, durationMs: e.data.durationMs };
    }),
    bus.on("input.flagged", (e) => {
      state.pendingModeration = {
        passed: false,
        categories: e.data.categories,
        categoryScores: e.data.categoryScores,
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
  agentId: string,
  reason: string,
  iterations: number,
  tokens: { promptTokens: number; completionTokens: number },
  errorMsg?: string,
): void {
  const entry = state.agentMap.get(agentId);
  if (!entry) return;

  const turn = state.turnMap.get(agentId);
  if (turn) {
    turn.update({ output: { outcome: reason } });
    turn.end();
    state.turnMap.delete(agentId);
  }

  const answer = state.agentAnswerMap.get(agentId);

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

  state.agentMap.delete(agentId);
  state.agentAnswerMap.delete(agentId);
  state.memoryMap.delete(`${agentId}:observation`);
  state.memoryMap.delete(`${agentId}:reflection`);
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