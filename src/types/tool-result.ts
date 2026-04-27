import type { ContentPart, ResourceRef } from "./llm.ts";
import type { WaitDescriptor } from "../agent/wait-descriptor.ts";

export interface ToolResult {
  content: ContentPart[];
  isError?: boolean;
  /** When set, the dispatch layer treats this as a park signal. */
  wait?: WaitDescriptor;
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
export function resource(path: string, description: string, mimeType?: string): ResourceRef {
  return { type: "resource", path, description, ...(mimeType !== undefined && { mimeType }) };
}
