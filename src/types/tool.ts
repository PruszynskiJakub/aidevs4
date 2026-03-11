export interface ToolDefinition {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<unknown>;
}

export interface ToolResponse<T = unknown> {
  status: "ok" | "error";
  data: T;
  hints?: string[];
}
