import type { LLMMessage } from "./llm.ts";

export interface Session {
  id: string;
  assistant?: string;
  messages: LLMMessage[];
  createdAt: Date;
  updatedAt: Date;
}
