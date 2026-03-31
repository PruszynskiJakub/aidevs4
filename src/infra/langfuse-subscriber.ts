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
  const toolMap = new Map<string, Observation>();    // callId  → tool span
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
      withAgentCtx(agentId, () => {
        const agentObs = agentMap.get(agentId)!.obs;
        const turn = agentObs.startObservation(
          `turn-${e.data.iteration}`,
          { input: { iteration: e.data.iteration, messageCount: e.data.messageCount } },
        );
        turnMap.set(agentId, turn);
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
      turn.update({ output: { outcome: e.data.outcome } });
      turn.end();
      turnMap.delete(agentId);
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
          { model: e.data.model, input: e.data.input },
          { asType: "generation" },
        );
        gen.update({
          output: e.data.output,
          usageDetails: {
            input: e.data.usage.input,
            output: e.data.usage.output,
          },
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
          { input: e.data.args },
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
      toolObs.update({ output: e.data.result });
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
      });
      toolObs.end();
      toolMap.delete(e.data.callId);
    }),
  );

  // ── agent.answer → set trace-level output ─────────────────

  unsubs.push(
    bus.on("agent.answer", (e) => {
      const agentId = e.agentId;
      const depth = e.depth ?? 0;
      if (!agentId || depth !== 0) return;
      const entry = agentMap.get(agentId);
      if (!entry) return;
      otelContext.with(entry.ctx, () => {
        entry.obs.setTraceIO({ output: e.data.text });
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

      otelContext.with(entry.ctx, () => {
        if (e.data.reason === "error") {
          entry.obs.update({
            level: "ERROR",
            statusMessage: e.data.error ?? "Unknown error",
          });
        }
        entry.obs.update({ output: { reason: e.data.reason, iterations: e.data.iterations } });
        entry.obs.end();
      });
      agentMap.delete(agentId);
    }),
  );

  return () => {
    for (const unsub of unsubs) unsub();
    agentMap.clear();
    turnMap.clear();
    toolMap.clear();
  };
}
