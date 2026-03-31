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

/**
 * Attaches a Langfuse subscriber to the event bus.
 * Maps domain events to Langfuse observations.
 * Returns a cleanup function.
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

  const agentObsMap = new Map<string, Observation>();
  const toolObsMap = new Map<string, Observation>();
  const unsubs: (() => void)[] = [];

  unsubs.push(
    bus.on("session.opened", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;

      const depth = e.depth ?? 0;
      const input = e.data.userInput;

      if (depth === 0) {
        // Root agent — create trace context
        propagateAttributes(
          { sessionId: e.sessionId, traceName: e.data.assistant },
          () => {
            const obs = startObservation(e.data.assistant, { input }, { asType: "agent" });
            obs.setTraceIO({ input });
            agentObsMap.set(agentId, obs);
          },
        );
      } else {
        // Child agent — nest under parent
        const parentId = e.parentAgentId;
        const parentObs = parentId ? agentObsMap.get(parentId) : undefined;
        if (parentObs) {
          const obs = parentObs.startObservation(
            e.data.assistant,
            { input },
            { asType: "agent" },
          );
          agentObsMap.set(agentId, obs);
        }
      }
    }),
  );

  unsubs.push(
    bus.on("generation.completed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const agentObs = agentObsMap.get(agentId);
      if (!agentObs) return;

      const gen = agentObs.startObservation(
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
    }),
  );

  unsubs.push(
    bus.on("tool.dispatched", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const agentObs = agentObsMap.get(agentId);
      if (!agentObs) return;

      const toolObs = agentObs.startObservation(
        e.data.name,
        { input: e.data.args },
        { asType: "tool" },
      );
      toolObsMap.set(e.data.callId, toolObs);
    }),
  );

  unsubs.push(
    bus.on("tool.succeeded", (e) => {
      const toolObs = toolObsMap.get(e.data.callId);
      if (!toolObs) return;
      toolObs.update({ output: e.data.result });
      toolObs.end();
      toolObsMap.delete(e.data.callId);
    }),
  );

  unsubs.push(
    bus.on("tool.failed", (e) => {
      const toolObs = toolObsMap.get(e.data.callId);
      if (!toolObs) return;
      toolObs.update({
        output: e.data.error,
        level: "ERROR",
        statusMessage: e.data.error,
      });
      toolObs.end();
      toolObsMap.delete(e.data.callId);
    }),
  );

  unsubs.push(
    bus.on("agent.answer", (e) => {
      const agentId = e.agentId;
      const depth = e.depth ?? 0;
      if (!agentId || depth !== 0) return;
      const agentObs = agentObsMap.get(agentId);
      if (!agentObs) return;
      agentObs.setTraceIO({ output: e.data.text });
    }),
  );

  unsubs.push(
    bus.on("session.closed", (e) => {
      const agentId = e.agentId;
      if (!agentId) return;
      const agentObs = agentObsMap.get(agentId);
      if (!agentObs) return;

      if (e.data.reason === "error") {
        agentObs.update({
          level: "ERROR",
          statusMessage: e.data.error ?? "Unknown error",
        });
      }

      agentObs.update({ output: { reason: e.data.reason, iterations: e.data.iterations } });
      agentObs.end();
      agentObsMap.delete(agentId);
    }),
  );

  return () => {
    for (const unsub of unsubs) unsub();
    agentObsMap.clear();
    toolObsMap.clear();
  };
}
