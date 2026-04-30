export interface McpStdioServer {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpServer {
  transport: "sse" | "http";
  url: string;
  /** OAuth configuration for authenticated remote MCP servers */
  oauth?: {
    /** Port for the local OAuth callback server (default: 8090) */
    callbackPort?: number;
  };
}

export type McpServerConfig = (McpStdioServer | McpHttpServer) & {
  name: string;
  enabled?: boolean;
};

export interface McpConfig {
  servers: McpServerConfig[];
}

export interface McpService {
  connect(): Promise<void>;
  registerTools(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectedServers(): string[];
}
