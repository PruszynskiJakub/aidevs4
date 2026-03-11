import type { ToolResponse } from "../types/tool.ts";

export function toolOk<T>(data: T, hints?: string[]): ToolResponse<T> {
  const response: ToolResponse<T> = { status: "ok", data };
  if (hints?.length) response.hints = hints;
  return response;
}

export function toolError(message: string, hints?: string[]): ToolResponse<{ error: string }> {
  const response: ToolResponse<{ error: string }> = {
    status: "error",
    data: { error: message },
  };
  if (hints?.length) response.hints = hints;
  return response;
}

export function isToolResponse(value: unknown): value is ToolResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "data" in value &&
    ((value as any).status === "ok" || (value as any).status === "error")
  );
}
