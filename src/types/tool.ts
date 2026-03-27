import type { Document } from "./document.ts";

export interface ToolDefinition {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<Document | Document[]>;
}

