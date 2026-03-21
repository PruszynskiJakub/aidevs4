import type { Document } from "./document.ts";

export interface ToolDefinition {
  name: string;
  /* eslint-disable @typescript-eslint/no-explicit-any --
     Handlers receive schema-validated args from the dispatcher. TypeScript cannot
     express per-tool arg shapes without generics that would complicate registration.
     Runtime validation inside each handler is the safety net. */
  handler: (args: any) => Promise<Document | Document[]>;
}

export interface ToolFilter {
  include?: string[];
  exclude?: string[];
}
