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

  // ── turn.began → create turn span ─────────────────────────

  unsubs.push(
    bus.on("turn.began", (e) => {
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

  // ── turn.ended → end turn span ────────────────────────────

  unsubs.push(
    bus.on("turn.ended", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const turn = turnMap.get(agentId);
      if (!turn) return;
      turn.update({
        output: { outcome: e.data.outcome },
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

        const gen = parent.startObservation(
          `${e.data.name}-llm`,
          {
            model: e.data.model,
            input: e.data.input,
            startTime: toDate(e.data.startTime),
          },
          { asType: "generation" },
        );
        gen.update({
          output: e.data.output,
          usageDetails: {
            input: e.data.usage.input,
            output: e.data.usage.output,
          },
          endTime: toDate(e.data.startTime + e.data.durationMs),
        });
        gen.end();
      });
    }),
  );

  // ── tool.dispatched → open tool observation ───────────────

  unsubs.push(
    bus.on("tool.dispatched", (e) => {
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
        endTime: toDate((e.data.startTime ?? Date.now()) + e.data.durationMs),
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
        endTime: toDate((e.data.startTime ?? Date.now()) + e.data.durationMs),
      });
      toolObs.end();
      toolMap.delete(e.data.callId);
    }),
  );

  // ── agent.answer → set output on agent obs + trace ────────

  unsubs.push(
    bus.on("agent.answer", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const entry = agentMap.get(agentId);
      if (!entry) return;

      const answerText = e.data.text ?? "";
      agentAnswerMap.set(agentId, answerText);

      otelContext.with(entry.ctx, () => {
        // Set answer as output on the agent observation (root + child)
        entry.obs.update({ output: truncate(answerText, 5000) });
        // For root agent, also set at trace level
        if ((e.depth ?? 0) === 0) {
          entry.obs.setTraceIO({ output: e.data.text });
        }
      });
    }),
  );

  // ── session.closed → end agent observation ────────────────

  unsubs.push(
    bus.on("session.closed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const entry = agentMap.get(agentId);
      if (!entry) return;

      // End any dangling turn span
      const turn = turnMap.get(agentId);
      if (turn) {
        turn.update({ output: { outcome: e.data.reason } });
        turn.end();
        turnMap.delete(agentId);
      }

      const answer = agentAnswerMap.get(agentId);

      otelContext.with(entry.ctx, () => {
        if (e.data.reason === "error") {
          entry.obs.update({
            level: "ERROR",
            statusMessage: e.data.error ?? "Unknown error",
          });
        }

        const totalInput = e.data.tokens.plan.promptTokens + e.data.tokens.act.promptTokens;
        const totalOutput = e.data.tokens.plan.completionTokens + e.data.tokens.act.completionTokens;

        entry.obs.update({
          output: {
            reason: e.data.reason,
            iterations: e.data.iterations,
            ...(answer && { answer: truncate(answer, 2000) }),
          },
          metadata: {
            totalTokens: { input: totalInput, output: totalOutput, total: totalInput + totalOutput },
          },
          endTime: toDate(Date.now()),
        });
        entry.obs.end();
      });
      agentMap.delete(agentId);
      agentAnswerMap.delete(agentId);
    }),
  );

  // ── memory.observation → memory compression span ──────────

  unsubs.push(
    bus.on("memory.observation", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(agentId, () => {
        const parent = parentFor(agentId);
        if (!parent) return;
        const obs = parent.startObservation("memory-observation", {
          input: { tokensBefore: e.data.tokensBefore },
        });
        obs.update({
          output: { tokensAfter: e.data.tokensAfter, compression: `${e.data.tokensBefore} → ${e.data.tokensAfter}` },
          level: "DEBUG",
        });
        obs.end();
      });
    }),
  );

  // ── memory.reflection → memory reflection span ───────────

  unsubs.push(
    bus.on("memory.reflection", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      withAgentCtx(agentId, () => {
        const parent = parentFor(agentId);
        if (!parent) return;
        const obs = parent.startObservation(`memory-reflection-L${e.data.level}`, {
          input: { level: e.data.level, tokensBefore: e.data.tokensBefore },
        });
        obs.update({
          output: { tokensAfter: e.data.tokensAfter, compression: `${e.data.tokensBefore} → ${e.data.tokensAfter}` },
          level: "DEBUG",
        });
        obs.end();
      });
    }),
  );

  return () => {
    for (const unsub of unsubs) unsub();
    agentMap.clear();
    turnMap.clear();
    turnStartMap.clear();
    toolMap.clear();
    agentAnswerMap.clear();
  };
}
