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
      log.info(`Assistant: ${e.assistant} (${e.model})`);
    }),
  );

  unsubs.push(
    bus.on("run.completed", (e) => {
      if (!mine(e.sessionId)) return;
      if (e.reason === "max_iterations") {
        log.maxIter(e.iterations);
      }
      // "answer" reason — answer text is emitted separately via agent.answered event
    }),
  );

  unsubs.push(
    bus.on("run.failed", (e) => {
      if (!mine(e.sessionId)) return;
      log.error(`Run failed: ${e.error}`);
    }),
  );

  unsubs.push(
    bus.on("agent.started", (e) => {
      if (!mine(e.sessionId)) return;
      log.info(`Agent: ${e.agentName} (${e.model}, depth=${e.depth})`);
    }),
  );

  unsubs.push(
    bus.on("turn.started", (e) => {
      if (!mine(e.sessionId)) return;
      log.step(
        e.index + 1,
        e.maxTurns,
        e.model,
        e.messageCount,
      );
    }),
  );

  unsubs.push(
    bus.on("generation.completed", (e) => {
      if (!mine(e.sessionId)) return;
      if (e.name === "act") {
        log.llm(
          formatMs(e.durationMs),
          e.usage.input,
          e.usage.output,
        );
      }
    }),
  );

  unsubs.push(
    bus.on("tool.called", (e) => {
      if (!mine(e.sessionId)) return;
      if (e.batchIndex === 0) {
        log.toolHeader(e.batchSize);
      }
      log.toolCall(e.name, e.args);
    }),
  );

  unsubs.push(
    bus.on("tool.succeeded", (e) => {
      if (!mine(e.sessionId)) return;
      log.toolOk(e.name, formatMs(e.durationMs), e.result);
    }),
  );

  unsubs.push(
    bus.on("tool.failed", (e) => {
      if (!mine(e.sessionId)) return;
      log.toolErr(e.name, e.error);
    }),
  );

  unsubs.push(
    bus.on("batch.completed", (e) => {
      if (!mine(e.sessionId)) return;
      log.batchDone(e.count, formatMs(e.durationMs));
    }),
  );

  unsubs.push(
    bus.on("agent.answered", (e) => {
      if (!mine(e.sessionId)) return;
      log.answer(e.text);
    }),
  );

  unsubs.push(
    bus.on("memory.observation.completed", (e) => {
      if (!mine(e.sessionId)) return;
      log.memoryObserve(e.tokensBefore, e.tokensAfter);
    }),
  );

  unsubs.push(
    bus.on("memory.reflection.completed", (e) => {
      if (!mine(e.sessionId)) return;
      log.memoryReflect(
        e.level,
        e.tokensBefore,
        e.tokensAfter,
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
