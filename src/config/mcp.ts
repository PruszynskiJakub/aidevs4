import { join } from "path";
import { WORKSPACE_DIR } from "./paths.ts";
import type { McpServerConfig, McpConfig } from "../types/mcp.ts";

export type { McpStdioServer, McpHttpServer, McpServerConfig, McpConfig } from "../types/mcp.ts";

const MCP_CONFIG_PATH = join(WORKSPACE_DIR, "mcp.json");

let cached: McpConfig | null = null;

export async function loadMcpConfig(): Promise<McpConfig> {
  if (cached) return cached;

  const file = Bun.file(MCP_CONFIG_PATH);
  if (!(await file.exists())) {
    cached = { servers: [] };
    return cached;
  }

  try {
    const raw = await file.json();
    const servers: McpServerConfig[] = Array.isArray(raw?.servers) ? raw.servers : [];
    cached = { servers };
    return cached;
  } catch {
    console.warn(`[mcp] Failed to parse ${MCP_CONFIG_PATH}, using empty config`);
    cached = { servers: [] };
    return cached;
  }
}
