import type { LLMMessage } from "./llm.ts";

export interface MemoryState {
  activeObservations: string;
  lastObservedIndex: number;
  observationTokenCount: number;
  generationCount: number;
}

export interface MemoryConfig {
  observationThreshold: number;
  reflectionThreshold: number;
  reflectionTarget: number;
  tailBudgetRatio: number;
  maxReflectionLevels: number;
  truncationLimits: {
    message: number;
    toolPayload: number;
  };
}

export interface ProcessedContext {
  systemPrompt: string;
  messages: LLMMessage[];
}

export function emptyMemoryState(): MemoryState {
  return {
    activeObservations: "",
    lastObservedIndex: 0,
    observationTokenCount: 0,
    generationCount: 0,
  };
}
