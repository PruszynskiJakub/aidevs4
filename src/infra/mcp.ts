import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { LLMProvider, LLMMessage, ContentPart } from "../types/llm.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { registerRaw } from "../tools/registry.ts";
import { loadMcpConfig } from "../config/mcp.ts";
import type { McpServerConfig } from "../config/mcp.ts";
import { config } from "../config/index.ts";

interface ConnectedServer {
  client: Client;
  transport: Transport;
  config: McpServerConfig;
}

/** Normalize a tool name to be safe for OpenAI function names (alphanumeric + underscores). */
function normalizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function createTransport(serverConfig: McpServerConfig): Transport {
  switch (serverConfig.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env,
      });
    case "sse":
      return new SSEClientTransport(new URL(serverConfig.url));
    case "http":
      return new StreamableHTTPClientTransport(new URL(serverConfig.url));
    default:
      throw new Error(`Unknown MCP transport: ${(serverConfig as McpServerConfig).transport}`);
  }
}

/** Map MCP tool result content to our ContentPart[]. */
function mapMcpContent(content: unknown[]): ContentPart[] {
  return (content as Record<string, unknown>[]).map((item): ContentPart => {
    const type = item.type as string;
    if (type === "text") {
      return { type: "text", text: item.text as string };
    }
    if (type === "image") {
      return {
        type: "image",
        data: item.data as string,
        mimeType: item.mimeType as string,
      };
    }
    if (type === "resource") {
      const resource = item.resource as Record<string, unknown>;
      return {
        type: "resource",
        uri: resource.uri as string,
        description: (resource.text as string) ?? (resource.uri as string),
        mimeType: resource.mimeType as string | undefined,
      };
    }
    // Fallback: serialize unknown content types as text
    return { type: "text", text: JSON.stringify(item) };
  });
}

export interface McpService {
  connect(): Promise<void>;
  registerTools(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectedServers(): string[];
}

export function createMcpService(llmProvider: LLMProvider): McpService {
  const servers = new Map<string, ConnectedServer>();
  let connected = false;

  // Track stdio child PIDs for zombie cleanup
  const stdioTransports = new Set<StdioClientTransport>();

  process.on("exit", () => {
    for (const transport of stdioTransports) {
      try {
        const pid = transport.pid;
        if (pid != null) process.kill(pid);
      } catch {
        // Process may already be dead
      }
    }
  });

  function setupSamplingHandler(client: Client): void {
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const messages: LLMMessage[] = request.params.messages.map((msg) => {
        const content = msg.content;
        let text: string;
        if (typeof content === "string") {
          text = content;
        } else if (content.type === "text") {
          text = content.text;
        } else {
          text = `[${content.type}]`;
        }

        return {
          role: msg.role as "user" | "assistant",
          content: text,
        };
      });

      if (request.params.systemPrompt) {
        messages.unshift({ role: "system", content: request.params.systemPrompt });
      }

      const modelHint = request.params.modelPreferences?.hints?.[0]?.name;

      const response = await llmProvider.chatCompletion({
        model: modelHint ?? config.models.agent,
        messages,
        maxTokens: request.params.maxTokens,
      });

      return {
        model: modelHint ?? config.models.agent,
        role: "assistant" as const,
        content: {
          type: "text" as const,
          text: response.content ?? "",
        },
      };
    });
  }

  return {
    async connect(): Promise<void> {
      if (connected) return;
      connected = true;

      const mcpConfig = await loadMcpConfig();
      if (mcpConfig.servers.length === 0) return;

      for (const serverConfig of mcpConfig.servers) {
        if (serverConfig.enabled === false) continue;

        try {
          const client = new Client(
            { name: "aidevs4-agent", version: "1.0.0" },
            { capabilities: { sampling: {} } },
          );

          setupSamplingHandler(client);

          const transport = createTransport(serverConfig);

          if (transport instanceof StdioClientTransport) {
            stdioTransports.add(transport);
          }

          await client.connect(transport);
          servers.set(serverConfig.name, { client, transport, config: serverConfig });
          console.log(`[mcp] Connected to "${serverConfig.name}"`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[mcp] Failed to connect to "${serverConfig.name}": ${msg}`);
        }
      }
    },

    async registerTools(): Promise<void> {
      for (const [serverName, server] of servers) {
        try {
          const { tools } = await server.client.listTools();

          for (const tool of tools) {
            const registeredName = `mcp_${normalizeName(serverName)}_${normalizeName(tool.name)}`;
            const description = tool.description ?? `MCP tool ${tool.name} from ${serverName}`;
            const parameters = (tool.inputSchema as Record<string, unknown>) ?? {
              type: "object",
              properties: {},
            };

            const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
              // Check if server is still connected
              const srv = servers.get(serverName);
              if (!srv) {
                return {
                  content: [{ type: "text", text: `Error: MCP server "${serverName}" is disconnected` }],
                  isError: true,
                };
              }

              try {
                const result = await srv.client.callTool(
                  { name: tool.name, arguments: args },
                  undefined,
                  { signal: AbortSignal.timeout(config.limits.fetchTimeout) },
                );

                const content = Array.isArray(result.content)
                  ? mapMcpContent(result.content)
                  : [{ type: "text" as const, text: String(result.content ?? "") }];

                return {
                  content,
                  isError: result.isError === true,
                };
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                  content: [{ type: "text", text: `Error calling MCP tool "${tool.name}" on "${serverName}": ${msg}` }],
                  isError: true,
                };
              }
            };

            try {
              registerRaw(registeredName, description, parameters, handler);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[mcp] Failed to register tool "${registeredName}": ${msg}`);
            }
          }

          console.log(`[mcp] Registered ${tools.length} tool(s) from "${serverName}"`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[mcp] Failed to list tools from "${serverName}": ${msg}`);
        }
      }
    },

    async disconnect(): Promise<void> {
      for (const [name, server] of servers) {
        try {
          await server.client.close();
        } catch {
          // Ignore close errors
        }
        if (server.transport instanceof StdioClientTransport) {
          stdioTransports.delete(server.transport);
        }
      }
      servers.clear();
      connected = false;
    },

    getConnectedServers(): string[] {
      return Array.from(servers.keys());
    },
  };
}
