import { executeRun } from "../agent/orchestrator.ts";
import { bus } from "../infra/events.ts";
import type { AgentEvent } from "../types/events.ts";
import type { AgentOutput } from "./types.ts";

/**
 * Run the agent on a single eval case message and capture structured output
 * by listening to bus events. Each call is fully isolated (ephemeral session).
 */
export async function runEvalCase(message: string): Promise<AgentOutput> {
  const toolNames: string[] = [];
  let iterations = 0;
  let totalTokens = { input: 0, output: 0, total: 0 };
  let capturedRunId: string | undefined;

  // We capture the runId from the first tool or generation event,
  // then filter subsequent events to that run only.
  const unsubs: Array<() => void> = [];

  const matchRun = (event: AgentEvent): boolean => {
    if (!capturedRunId) {
      capturedRunId = event.runId;
      return true;
    }
    return event.runId === capturedRunId;
  };

  unsubs.push(
    bus.on("tool.succeeded", (event) => {
      if (matchRun(event)) toolNames.push(event.name);
    }),
  );

  unsubs.push(
    bus.on("tool.failed", (event) => {
      if (matchRun(event)) toolNames.push(event.name);
    }),
  );

  unsubs.push(
    bus.on("generation.completed", (event) => {
      if (matchRun(event)) {
        totalTokens.input += event.usage.input;
        totalTokens.output += event.usage.output;
        totalTokens.total += event.usage.total;
      }
    }),
  );

  unsubs.push(
    bus.on("cycle.completed", (event) => {
      if (matchRun(event)) iterations = event.iteration;
    }),
  );

  const start = performance.now();

  try {
    const { exit } = await executeRun({ prompt: message });
    const answer = exit.kind === "completed" ? exit.result : "";

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
