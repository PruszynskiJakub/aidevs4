import type { ContentPart, ResourceRef } from "./llm.ts";

export interface ToolResult {
  content: ContentPart[];
  isError?: boolean;
}

/** Create a ToolResult with a single text part. */
export function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

/** Create an error ToolResult. */
export function error(msg: string): ToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

/** Create a ResourceRef content part. */
export function resource(uri: string, description: string, mimeType?: string): ResourceRef {
  return { type: "resource", uri, description, ...(mimeType !== undefined && { mimeType }) };
}
