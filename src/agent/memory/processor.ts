import type { LLMProvider, LLMMessage } from "../../types/llm.ts";
import type { MemoryState, ProcessedContext } from "../../types/memory.ts";
import { config } from "../../config/index.ts";
import { estimateTokens, estimateMessagesTokens } from "../../utils/tokens.ts";
import { observe } from "./observer.ts";
import { reflect } from "./reflector.ts";
import { saveDebugArtifact } from "./persistence.ts";
import { bus } from "../../infra/events.ts";

const OBSERVATION_HEADER = "\n\n---\n\n## Memory Observations\n\n";

function appendObservationsToPrompt(
  systemPrompt: string,
  observations: string,
): string {
  if (!observations) return systemPrompt;
  return systemPrompt + OBSERVATION_HEADER + observations;
}

function combineObservations(existing: string, added: string): string {
  if (!added) return existing;
  return existing ? existing + "\n\n" + added : added;
}

function passThrough(
  systemPrompt: string,
  messages: LLMMessage[],
  state: MemoryState,
): { context: ProcessedContext; state: MemoryState } {
  return {
    context: {
      systemPrompt: appendObservationsToPrompt(systemPrompt, state.activeObservations),
      messages,
    },
    state,
  };
}

export async function processMemory(
  systemPrompt: string,
  messages: LLMMessage[],
  state: MemoryState,
  provider: LLMProvider,
  sessionId: string,
): Promise<{ context: ProcessedContext; state: MemoryState }> {
  const memConfig = config.memory;

  // Calculate unobserved message tokens (from lastObservedIndex to end)
  const unobservedMessages = messages.slice(state.lastObservedIndex);
  const unobservedTokens = estimateMessagesTokens(unobservedMessages);

  // Below threshold — pass through unchanged
  if (unobservedTokens < memConfig.observationThreshold) {
    return passThrough(systemPrompt, messages, state);
  }

  // Above threshold — split at tail budget, observe old messages
  const tailBudget = Math.floor(memConfig.observationThreshold * memConfig.tailBudgetRatio);
  let tailCount = 0;
  let tailTokens = 0;

  // Walk backwards from the end to find tail boundary
  for (let i = messages.length - 1; i >= state.lastObservedIndex; i--) {
    const msgTokens = estimateMessagesTokens([messages[i]]);
    if (tailTokens + msgTokens > tailBudget) break;
    tailTokens += msgTokens;
    tailCount++;
  }

  let splitIndex = messages.length - tailCount;

  // Ensure the split doesn't orphan tool responses from their tool_calls.
  // If tail starts with role:"tool" messages, pull splitIndex back to include
  // the preceding assistant message that issued the tool_calls.
  while (
    splitIndex > state.lastObservedIndex &&
    messages[splitIndex]?.role === "tool"
  ) {
    splitIndex--;
  }

  const messagesToObserve = messages.slice(state.lastObservedIndex, splitIndex);
  const tailMessages = messages.slice(splitIndex);

  if (messagesToObserve.length === 0) {
    return passThrough(systemPrompt, messages, state);
  }

  // Run observer
  const tokensBefore = state.observationTokenCount;
  const newObservations = await observe(
    messagesToObserve,
    state.activeObservations,
    provider,
  );

  const updatedObservations = combineObservations(state.activeObservations, newObservations);

  const observationTokens = estimateTokens(updatedObservations);
  bus.emit("memory.observation", { tokensBefore, tokensAfter: observationTokens });

  // Save observer debug artifact
  await saveDebugArtifact(sessionId, "observer", newObservations || "(no new observations)", {
    lastObservedIndex: state.lastObservedIndex,
    splitIndex,
    messagesObserved: messagesToObserve.length,
    tokensBefore,
    tokensAfter: observationTokens,
  });

  // Update state
  const newState: MemoryState = {
    activeObservations: updatedObservations,
    lastObservedIndex: splitIndex,
    observationTokenCount: observationTokens,
    generationCount: state.generationCount,
  };

  // Check if reflection is needed
  if (observationTokens > memConfig.reflectionThreshold) {
    const reflectTokensBefore = observationTokens;
    const compressed = await reflect(
      updatedObservations,
      memConfig.reflectionTarget,
      provider,
    );

    const compressedTokens = estimateTokens(compressed);
    newState.activeObservations = compressed;
    newState.observationTokenCount = compressedTokens;
    newState.generationCount += 1;

    bus.emit("memory.reflection", {
      level: newState.generationCount,
      tokensBefore: reflectTokensBefore,
      tokensAfter: compressedTokens,
    });

    // Save reflector debug artifact
    await saveDebugArtifact(sessionId, "reflector", compressed, {
      generationCount: newState.generationCount,
      tokensBefore: reflectTokensBefore,
      tokensAfter: compressedTokens,
      target: memConfig.reflectionTarget,
    });
  }

  // Return processed context: drop observed messages, keep tail
  return {
    context: {
      systemPrompt: appendObservationsToPrompt(systemPrompt, newState.activeObservations),
      messages: tailMessages,
    },
    state: newState,
  };
}

/** Flush any remaining unprocessed messages through the observer at session end. */
export async function flushMemory(
  messages: LLMMessage[],
  state: MemoryState,
  provider: LLMProvider,
  sessionId: string,
): Promise<MemoryState> {
  const unobservedMessages = messages.slice(state.lastObservedIndex);
  if (unobservedMessages.length === 0) return state;

  // Only flush if there's meaningful content to observe
  const unobservedTokens = estimateMessagesTokens(unobservedMessages);
  if (unobservedTokens < 1_000) return state;

  const tokensBefore = state.observationTokenCount;
  const newObservations = await observe(
    unobservedMessages,
    state.activeObservations,
    provider,
  );

  if (!newObservations) return state;

  const updatedObservations = combineObservations(state.activeObservations, newObservations);

  const observationTokens = estimateTokens(updatedObservations);
  bus.emit("memory.observation", { tokensBefore, tokensAfter: observationTokens });

  await saveDebugArtifact(sessionId, "observer", newObservations, {
    flush: true,
    lastObservedIndex: state.lastObservedIndex,
    messagesObserved: unobservedMessages.length,
    tokensBefore,
    tokensAfter: observationTokens,
  });

  return {
    activeObservations: updatedObservations,
    lastObservedIndex: messages.length,
    observationTokenCount: observationTokens,
    generationCount: state.generationCount,
  };
}
