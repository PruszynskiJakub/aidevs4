import type { Logger } from "../../types/logger.ts";
import type { EventBus } from "../../types/events.ts";

/**
 * Subscribes to domain events on the bus and renders them
 * through the provided Logger (typically a CompositeLogger
 * wrapping console + markdown targets).
 *
 * This is the Bus→Logger direction: the agent loop emits
 * semantic events, this listener translates them into
 * human-readable log output.
 *
 * Returns an unsubscribe function to detach all listeners.
 */
export function attachLoggerListener(
  bus: EventBus,
  log: Logger,
  sessionId?: string,
): () => void {
  const unsubs: (() => void)[] = [];

  /** Only process events belonging to this session (when sessionId is set). */
  function mine(eventSessionId?: string): boolean {
    return !sessionId || eventSessionId === sessionId;
  }

  unsubs.push(
    bus.on("run.started", (e) => {
      if (!mine(e.sessionId)) return;
      log.info(`Assistant: ${e.data.assistant} (${e.data.model})`);
    }),
  );

  unsubs.push(
    bus.on("run.completed", (e) => {
      if (!mine(e.sessionId)) return;
      if (e.data.reason === "max_iterations") {
        log.maxIter(e.data.iterations);
      }
      // "answer" reason — answer text is emitted separately via agent.answered event
    }),
  );

  unsubs.push(
    bus.on("run.failed", (e) => {
      if (!mine(e.sessionId)) return;
      log.error(`Run failed: ${e.data.error}`);
    }),
  );

  unsubs.push(
    bus.on("agent.started", (e) => {
      if (!mine(e.sessionId)) return;
      log.info(`Agent: ${e.data.agentName} (${e.data.model}, depth=${e.data.depth})`);
    }),
  );

  unsubs.push(
    bus.on("cycle.started", (e) => {
      if (!mine(e.sessionId)) return;
      log.step(
        e.data.iteration,
        e.data.maxIterations,
        e.data.model,
        e.data.messageCount,
      );
    }),
  );

  unsubs.push(
    bus.on("generation.completed", (e) => {
      if (!mine(e.sessionId)) return;
      if (e.data.name === "act") {
        log.llm(
          formatMs(e.data.durationMs),
          e.data.usage.input,
          e.data.usage.output,
        );
      }
    }),
  );

  unsubs.push(
    bus.on("tool.called", (e) => {
      if (!mine(e.sessionId)) return;
      if (e.data.batchIndex === 0) {
        log.toolHeader(e.data.batchSize);
      }
      log.toolCall(e.data.name, e.data.args);
    }),
  );

  unsubs.push(
    bus.on("tool.succeeded", (e) => {
      if (!mine(e.sessionId)) return;
      log.toolOk(e.data.name, formatMs(e.data.durationMs), e.data.result);
    }),
  );

  unsubs.push(
    bus.on("tool.failed", (e) => {
      if (!mine(e.sessionId)) return;
      log.toolErr(e.data.name, e.data.error);
    }),
  );

  unsubs.push(
    bus.on("batch.completed", (e) => {
      if (!mine(e.sessionId)) return;
      log.batchDone(e.data.count, formatMs(e.data.durationMs));
    }),
  );

  unsubs.push(
    bus.on("agent.answered", (e) => {
      if (!mine(e.sessionId)) return;
      log.answer(e.data.text);
    }),
  );

  unsubs.push(
    bus.on("memory.observation.completed", (e) => {
      if (!mine(e.sessionId)) return;
      log.memoryObserve(e.data.tokensBefore, e.data.tokensAfter);
    }),
  );

  unsubs.push(
    bus.on("memory.reflection.completed", (e) => {
      if (!mine(e.sessionId)) return;
      log.memoryReflect(
        e.data.level,
        e.data.tokensBefore,
        e.data.tokensAfter,
      );
    }),
  );

  return () => {
    for (const unsub of unsubs) unsub();
  };
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}