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
  ctx: Context; // OTel context captured inside propagateAttributes
}

function toDate(epoch: number): Date {
  return new Date(epoch);
}

function truncate(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [truncated, ${s.length} chars total]`;
}

type GenerationData = {
  name: string;
  model: string;
  input: unknown[];
  output: unknown;
  usage: { input: number; output: number; total: number };
  startTime: number;
  durationMs: number;
};

/** Create a generation child observation under `parent`, with usage and timing. */
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

  let startObservation: (
    name: string,
    attrs?: Record<string, unknown>,
    opts?: { asType?: string },
  ) => Observation;
  let propagateAttributes: (
    attrs: Record<string, unknown>,
    fn: () => void,
  ) => void;

  try {
    const tracing = require("@langfuse/tracing");
    startObservation = tracing.startObservation;
    propagateAttributes = tracing.propagateAttributes;
  } catch {
    console.warn("[langfuse] Failed to import @langfuse/tracing");
    return () => {};
  }

  const agentMap = new Map<string, AgentEntry>();
  const turnMap = new Map<string, Observation>();   // agentId → current turn span
  const turnStartMap = new Map<string, number>();   // agentId → turn start epoch
  const toolMap = new Map<string, Observation>();    // callId  → tool span
  const agentAnswerMap = new Map<string, string>();  // agentId → answer text
  const unsubs: (() => void)[] = [];

  // Buffered moderation data — moderation fires before agent span exists
  // (no agentId/sessionId in context yet), so we store the latest result
  // and replay it when session.opened creates the root agent span.
  type ModerationBuffer = { passed: true; durationMs: number } | { passed: false; categories: string[]; categoryScores: Record<string, number> };
  let pendingModeration: ModerationBuffer | null = null;

  /** Run `fn` inside the saved OTel context for the given agent. */
  function withAgentCtx<T>(agentId: string, fn: () => T): T | undefined {
    const entry = agentMap.get(agentId);
    if (!entry) return undefined;
    return otelContext.with(entry.ctx, fn);
  }

  /** Get the current parent for nesting: turn span if active, otherwise agent span. */
  function parentFor(agentId: string): Observation | undefined {
    return turnMap.get(agentId) ?? agentMap.get(agentId)?.obs;
  }

  /** Create a guardrail observation from buffered moderation data. */
  function flushModeration(agentObs: Observation): void {
    const buf = pendingModeration;
    if (!buf) return;
    pendingModeration = null;

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

  // ── session.opened → create agent observation ─────────────

  unsubs.push(
    bus.on("session.opened", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;

      const depth = e.depth ?? 0;
      const input = e.data.userInput;

      if (depth === 0) {
        // Root agent — create inside propagateAttributes to capture context
        propagateAttributes(
          { sessionId: e.sessionId, traceName: e.data.assistant },
          () => {
            const obs = startObservation(e.data.assistant, { input }, { asType: "agent" });
            obs.setTraceIO({ input });
            agentMap.set(agentId, { obs, ctx: otelContext.active() });
            // Flush any buffered moderation result as the first child
            flushModeration(obs);
          },
        );
      } else {
        // Child agent — nest under parent, reuse parent's OTel context
        const parentId = e.parentAgentId;
        if (!parentId) return;
        withAgentCtx(parentId, () => {
          const parentObs = agentMap.get(parentId)!.obs;
          const obs = parentObs.startObservation(
            e.data.assistant,
            { input },
            { asType: "agent" },
          );
          // Child shares the parent's OTel context (inherits sessionId etc.)
          agentMap.set(agentId, { obs, ctx: otelContext.active() });
        });
      }
    }),
  );

  // ── turn.started → create turn span ─────────────────────────

  unsubs.push(
    bus.on("turn.started", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const now = Date.now();
      withAgentCtx(agentId, () => {
        const agentObs = agentMap.get(agentId)!.obs;
        const turn = agentObs.startObservation(
          `turn-${e.data.iteration}`,
          {
            input: { iteration: e.data.iteration, messageCount: e.data.messageCount },
            startTime: toDate(now),
          },
        );
        turnMap.set(agentId, turn);
        turnStartMap.set(agentId, now);
      });
    }),
  );

  // ── turn.completed → end turn span ────────────────────────────

  unsubs.push(
    bus.on("turn.completed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const turn = turnMap.get(agentId);
      if (!turn) return;
      turn.update({
        output: { outcome: e.data.outcome, durationMs: e.data.durationMs },
        endTime: toDate(Date.now()),
      });
      turn.end();
      turnMap.delete(agentId);
      turnStartMap.delete(agentId);
    }),
  );

  // ── generation.completed → generation observation ─────────

  unsubs.push(
    bus.on("generation.completed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(agentId, () => {
        const parent = parentFor(agentId);
        if (!parent) return;

        // Convert output to OpenAI ChatML format for Langfuse playground compatibility
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
  );

  // ── tool.called → open tool observation ───────────────

  unsubs.push(
    bus.on("tool.called", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(agentId, () => {
        const parent = parentFor(agentId);
        if (!parent) return;

        const toolObs = parent.startObservation(
          e.data.name,
          {
            input: e.data.args,
            startTime: toDate(e.data.startTime),
          },
          { asType: "tool" },
        );
        toolMap.set(e.data.callId, toolObs);
      });
    }),
  );

  // ── tool.succeeded → close tool observation ───────────────

  unsubs.push(
    bus.on("tool.succeeded", (e) => {
      const toolObs = toolMap.get(e.data.callId);
      if (!toolObs) return;
      toolObs.update({
        output: e.data.result,
        endTime: toDate(Date.now()),
      });
      toolObs.end();
      toolMap.delete(e.data.callId);
    }),
  );

  // ── tool.failed → close tool observation with error ───────

  unsubs.push(
    bus.on("tool.failed", (e) => {
      const toolObs = toolMap.get(e.data.callId);
      if (!toolObs) return;
      toolObs.update({
        output: e.data.error,
        level: "ERROR",
        statusMessage: e.data.error,
        endTime: toDate(Date.now()),
      });
      toolObs.end();
      toolMap.delete(e.data.callId);
    }),
  );

  // ── agent.answered → set output on agent obs + trace ────────

  unsubs.push(
    bus.on("agent.answered", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const entry = agentMap.get(agentId);
      if (!entry) return;

      const answerText = truncate(e.data.text ?? "", 5000);
      agentAnswerMap.set(agentId, answerText);

      otelContext.with(entry.ctx, () => {
        // Set answer as output on the agent observation (root + child)
        entry.obs.update({ output: answerText });
        // For root agent, also set at trace level
        if ((e.depth ?? 0) === 0) {
          entry.obs.setTraceIO({ output: answerText });
        }
      });
    }),
  );

  // ── session.completed → end agent observation ──────────────

  function endAgentObs(agentId: string, reason: string, iterations: number, tokens: { plan: { promptTokens: number; completionTokens: number }; act: { promptTokens: number; completionTokens: number } }, errorMsg?: string): void {
    const entry = agentMap.get(agentId);
    if (!entry) return;

    // End any dangling turn span
    const turn = turnMap.get(agentId);
    if (turn) {
      turn.update({ output: { outcome: reason } });
      turn.end();
      turnMap.delete(agentId);
    }

    const answer = agentAnswerMap.get(agentId);

    otelContext.with(entry.ctx, () => {
      if (errorMsg) {
        entry.obs.update({
          level: "ERROR",
          statusMessage: errorMsg,
        });
      }

      const totalInput = tokens.plan.promptTokens + tokens.act.promptTokens;
      const totalOutput = tokens.plan.completionTokens + tokens.act.completionTokens;

      entry.obs.update({
        output: answer || null,
        metadata: {
          reason,
          iterations,
          totalTokens: { input: totalInput, output: totalOutput, total: totalInput + totalOutput },
        },
        endTime: toDate(Date.now()),
      });
      entry.obs.end();
    });
    agentMap.delete(agentId);
    agentAnswerMap.delete(agentId);
    memoryMap.delete(`${agentId}:observation`);
    memoryMap.delete(`${agentId}:reflection`);
  }

  unsubs.push(
    bus.on("session.completed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      endAgentObs(agentId, e.data.reason, e.data.iterations, e.data.tokens);
    }),
  );

  unsubs.push(
    bus.on("session.failed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      endAgentObs(agentId, "error", e.data.iterations, e.data.tokens, e.data.error);
    }),
  );

  // ── Memory maps ─────────────────────────────────────────────
  const memoryMap = new Map<string, Observation>();

  // ── memory.observation lifecycle ──────────────────────────

  unsubs.push(
    bus.on("memory.observation.started", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(agentId, () => {
        const parent = parentFor(agentId);
        if (!parent) return;
        const span = parent.startObservation("memory-observation", {
          input: { tokensBefore: e.data.tokensBefore },
          startTime: toDate(Date.now()),
        });
        memoryMap.set(`${agentId}:observation`, span);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.observation.completed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(agentId, () => {
        const span = memoryMap.get(`${agentId}:observation`);
        if (!span) return;
        nestGeneration(span, e.data.generation);
        span.update({
          output: { tokensAfter: e.data.tokensAfter, compression: `${e.data.tokensBefore} → ${e.data.tokensAfter}` },
          endTime: toDate(Date.now()),
        });
        span.end();
        memoryMap.delete(`${agentId}:observation`);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.observation.failed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const span = memoryMap.get(`${agentId}:observation`);
      if (!span) return;
      span.update({ level: "ERROR", statusMessage: e.data.error });
      span.end();
      memoryMap.delete(`${agentId}:observation`);
    }),
  );

  // ── memory.reflection lifecycle ───────────────────────────

  unsubs.push(
    bus.on("memory.reflection.started", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(agentId, () => {
        const parent = parentFor(agentId);
        if (!parent) return;
        const span = parent.startObservation(`memory-reflection-L${e.data.level}`, {
          input: { level: e.data.level, tokensBefore: e.data.tokensBefore },
          startTime: toDate(Date.now()),
        });
        memoryMap.set(`${agentId}:reflection`, span);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.reflection.completed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(agentId, () => {
        const span = memoryMap.get(`${agentId}:reflection`);
        if (!span) return;
        for (const gen of e.data.generations) {
          nestGeneration(span, gen);
        }
        span.update({
          output: { tokensAfter: e.data.tokensAfter, compression: `${e.data.tokensBefore} → ${e.data.tokensAfter}` },
          endTime: toDate(Date.now()),
        });
        span.end();
        memoryMap.delete(`${agentId}:reflection`);
      });
    }),
  );

  unsubs.push(
    bus.on("memory.reflection.failed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const span = memoryMap.get(`${agentId}:reflection`);
      if (!span) return;
      span.update({ level: "ERROR", statusMessage: e.data.error });
      span.end();
      memoryMap.delete(`${agentId}:reflection`);
    }),
  );

  // ── input moderation → buffer for replay on session.opened ──

  unsubs.push(
    bus.on("input.clean", (e) => {
      pendingModeration = { passed: true, durationMs: e.data.durationMs };
    }),
  );

  unsubs.push(
    bus.on("input.flagged", (e) => {
      pendingModeration = {
        passed: false,
        categories: e.data.categories,
        categoryScores: e.data.categoryScores,
      };
    }),
  );

  return () => {
    for (const unsub of unsubs) unsub();
    agentMap.clear();
    turnMap.clear();
    turnStartMap.clear();
    toolMap.clear();
    agentAnswerMap.clear();
    memoryMap.clear();
    pendingModeration = null;
  };
}
