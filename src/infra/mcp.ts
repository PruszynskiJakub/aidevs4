import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { LLMProvider, LLMMessage, ContentPart } from "../types/llm.ts";
import type { ToolAnnotations } from "../types/tool.ts";
import { type ToolResult, error as toolError } from "../types/tool-result.ts";
import { registerRaw } from "../tools/registry.ts";
import { errorMessage } from "../utils/parse.ts";
import { loadMcpConfig } from "../config/mcp.ts";
import type { McpServerConfig } from "../config/mcp.ts";
import { config } from "../config/index.ts";
import { createOAuthProvider, waitForOAuthCallback } from "./mcp-oauth.ts";

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
    case "http": {
      const opts: Record<string, unknown> = {};
      if (serverConfig.oauth) {
        const port = serverConfig.oauth.callbackPort ?? 8090;
        opts.authProvider = createOAuthProvider(serverConfig.name, port);
      }
      return new StreamableHTTPClientTransport(new URL(serverConfig.url), opts);
    }
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
      const res = item.resource as Record<string, unknown>;
      const rawUri = res.uri as string;
      let path: string;
      if (rawUri.startsWith("file://")) {
        path = rawUri.slice(7);
      } else {
        console.warn(`[mcp] Non-file URI from MCP resource, using raw: ${rawUri}`);
        path = rawUri;
      }
      return {
        type: "resource",
        path,
        description: (res.text as string) ?? rawUri,
        mimeType: res.mimeType as string | undefined,
      };
    }
    // Fallback: serialize unknown content types as text
    return { type: "text", text: JSON.stringify(item) };
  });
}

export type { McpService } from "../types/mcp.ts";
import type { McpService } from "../types/mcp.ts";

/** Kill stale mcp-remote processes left over from previous runs. */
async function killStaleMcpRemoteProcesses(): Promise<void> {
  try {
    const proc = Bun.spawn(["pgrep", "-f", "mcp-remote"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    const pids = output
      .trim()
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((pid) => !isNaN(pid) && pid !== process.pid);

    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }
    if (pids.length > 0) {
      console.log(`[mcp] Killed ${pids.length} stale mcp-remote process(es)`);
    }
  } catch {
    /* pgrep not found or no matches — nothing to clean up */
  }
}

export function createMcpService(llmProvider: LLMProvider): McpService {
  const servers = new Map<string, ConnectedServer>();
  let connected = false;

  process.on("exit", () => {
    for (const { transport } of servers.values()) {
      if (transport instanceof StdioClientTransport) {
        try {
          const pid = transport.pid;
          if (pid != null) process.kill(pid);
        } catch {
          /* already dead */
        }
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

      const model = request.params.modelPreferences?.hints?.[0]?.name ?? config.models.agent;

      const response = await llmProvider.chatCompletion({
        model,
        messages,
        maxTokens: request.params.maxTokens,
      });

      return {
        model,
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

      await killStaleMcpRemoteProcesses();

      const mcpConfig = await loadMcpConfig();
      if (mcpConfig.servers.length === 0) return;

      const enabled = mcpConfig.servers.filter((s) => s.enabled !== false);

      await Promise.allSettled(
        enabled.map(async (serverConfig) => {
          try {
            const client = new Client(
              { name: "aidevs4-agent", version: "1.0.0" },
              { capabilities: { sampling: {} } },
            );

            setupSamplingHandler(client);

            const transport = createTransport(serverConfig);

            try {
              await client.connect(transport);
            } catch (err) {
              // Handle OAuth flow for HTTP transports
              if (
                err instanceof UnauthorizedError &&
                serverConfig.transport === "http" &&
                serverConfig.oauth
              ) {
                const port = serverConfig.oauth.callbackPort ?? 8090;
                console.log(`[mcp] OAuth required for "${serverConfig.name}" — waiting for browser authorization...`);
                const { code, server: callbackServer } = await waitForOAuthCallback(port);
                try {
                  await (transport as StreamableHTTPClientTransport).finishAuth(code);
                  // Close the original client/transport before reconnecting
                  await client.close().catch(() => {});
                  // Create a fresh client + transport for the authenticated session
                  const newClient = new Client(
                    { name: "aidevs4-agent", version: "1.0.0" },
                    { capabilities: { sampling: {} } },
                  );
                  setupSamplingHandler(newClient);
                  const newTransport = createTransport(serverConfig);
                  await newClient.connect(newTransport);
                  servers.set(serverConfig.name, { client: newClient, transport: newTransport, config: serverConfig });
                  console.log(`[mcp] Connected to "${serverConfig.name}" (after OAuth)`);
                } finally {
                  callbackServer.close();
                }
                return;
              }
              throw err;
            }

            servers.set(serverConfig.name, { client, transport, config: serverConfig });
            console.log(`[mcp] Connected to "${serverConfig.name}"`);
          } catch (err) {
            console.warn(`[mcp] Failed to connect to "${serverConfig.name}": ${errorMessage(err)}`);
          }
        }),
      );
    },

    async registerTools(): Promise<void> {
      await Promise.allSettled(
        Array.from(servers, async ([serverName, server]) => {
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
                const srv = servers.get(serverName);
                if (!srv) {
                  return toolError(`MCP server "${serverName}" is disconnected`);
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
                  return toolError(`Error calling MCP tool "${tool.name}" on "${serverName}": ${errorMessage(err)}`);
                }
              };

              try {
                registerRaw(registeredName, description, parameters, handler, tool.annotations as ToolAnnotations | undefined);
              } catch (err) {
                console.warn(`[mcp] Failed to register tool "${registeredName}": ${errorMessage(err)}`);
              }
            }

            console.log(`[mcp] Registered ${tools.length} tool(s) from "${serverName}"`);
          } catch (err) {
            console.warn(`[mcp] Failed to list tools from "${serverName}": ${errorMessage(err)}`);
          }
        }),
      );
    },

    async disconnect(): Promise<void> {
      await Promise.allSettled(
        Array.from(servers.entries(), async ([name, server]) => {
          try {
            // For Streamable HTTP, terminate the server-side session first
            // (client.close() alone does NOT send a DELETE to the server)
            if (server.transport instanceof StreamableHTTPClientTransport) {
              await server.transport.terminateSession();
            }
            await server.client.close();
            console.log(`[mcp] Disconnected from "${name}"`);
          } catch (err) {
            console.warn(`[mcp] Error disconnecting from "${name}": ${errorMessage(err)}`);
          }
        }),
      );
      servers.clear();
      connected = false;
    },

    getConnectedServers(): string[] {
      return Array.from(servers.keys());
    },
  };
}
