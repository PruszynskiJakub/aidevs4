import { executeTurn } from "../agent/orchestrator.ts";
import { bus } from "../infra/events.ts";
import type { BusEvent } from "../types/events.ts";
import type { AgentOutput } from "./types.ts";

/**
 * Run the agent on a single eval case message and capture structured output
 * by listening to bus events. Each call is fully isolated (ephemeral session).
 */
export async function runEvalCase(message: string): Promise<AgentOutput> {
  const toolNames: string[] = [];
  let iterations = 0;
  let totalTokens = { input: 0, output: 0, total: 0 };
  let capturedAgentId: string | undefined;

  // We capture the agentId from the first tool or generation event,
  // then filter subsequent events to that agent only.
  const unsubs: Array<() => void> = [];

  const matchAgent = (event: BusEvent): boolean => {
    if (!capturedAgentId) {
      capturedAgentId = event.agentId;
      return true;
    }
    return event.agentId === capturedAgentId;
  };

  unsubs.push(
    bus.on("tool.succeeded", (event) => {
      if (matchAgent(event)) toolNames.push(event.data.name);
    }),
  );

  unsubs.push(
    bus.on("tool.failed", (event) => {
      if (matchAgent(event)) toolNames.push(event.data.name);
    }),
  );

  unsubs.push(
    bus.on("generation.completed", (event) => {
      if (matchAgent(event)) {
        totalTokens.input += event.data.usage.input;
        totalTokens.output += event.data.usage.output;
        totalTokens.total += event.data.usage.total;
      }
    }),
  );

  unsubs.push(
    bus.on("turn.completed", (event) => {
      if (matchAgent(event)) iterations = event.data.iteration;
    }),
  );

  const start = performance.now();

  try {
    const { answer } = await executeTurn({ prompt: message });

    return {
      response: answer,
      toolNames,
      toolCalls: toolNames.length,
      iterations,
      tokens: totalTokens,
      durationMs: Math.round(performance.now() - start),
    };
  } finally {
    for (const unsub of unsubs) unsub();
  }
}
