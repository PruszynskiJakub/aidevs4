import type { Document } from "./document.ts";

export interface ToolDefinition {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<Document | Document[]>;
}
