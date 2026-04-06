import type { MemoryGeneration } from "./events.ts";

export interface ObserveResult {
  text: string;
  generation: MemoryGeneration;
}

export interface ReflectResult {
  text: string;
  generations: MemoryGeneration[];
}
