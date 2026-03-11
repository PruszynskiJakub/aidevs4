import type { LLMMessage } from "./llm.ts";

export interface Session {
  id: string;
  messages: LLMMessage[];
  createdAt: Date;
  updatedAt: Date;
}
