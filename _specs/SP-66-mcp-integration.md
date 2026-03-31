# SP-66 MCP Integration

## Main objective

Add Model Context Protocol (MCP) client support so the agent can connect to local (stdio) and remote (SSE / Streamable HTTP) MCP servers, expose their tools through the existing registry, filter them per agent, and handle sampling callbacks by routing them through the LLM layer.

## Context

The agent's toolbox grows with each task, but all tools today are local TypeScript implementations in `src/tools/`. MCP lets us connect to external tool servers — both local processes (stdio transport) and remote services (SSE / Streamable HTTP) — without writing bespoke integrations for each. An MCP server can also request LLM completions from the client via the **sampling** capability, enabling server-side agentic workflows (e.g. a code-analysis server that needs to ask the LLM follow-up questions mid-tool-execution).

The architecture choice is **Option C** from our discussion: a dedicated `src/infra/mcp.ts` service that manages MCP connections, wraps discovered tools as native `ToolDefinition` objects, and handles sampling callbacks by routing them through `src/llm/llm.ts`. The agent loop, dispatch, and LLM providers remain unaware of MCP.

## Out of scope

- MCP **resources** and **prompts** capabilities (tools only for now)
- MCP server implementation (we are a client only)
- Dynamic runtime discovery (servers are statically configured)
- MCP tool argument validation beyond what the server declares (server owns its schema)
- Authentication/OAuth for remote MCP servers (plain HTTP/SSE first)
- MCP **roots** capability
- Notifications beyond connection lifecycle

## Constraints

- **Bun runtime**: The MCP TypeScript SDK (`@modelcontextprotocol/sdk`) must work under Bun. Stdio and HTTP transports are expected to work; verify SSE transport compatibility.
- **Minimal registry addition**: A new `registerRaw()` function is added to accept pre-built JSON Schema. The existing `register()`, `ToolDefinition`, `ToolSchema`, `LLMTool` types do not change.
- **No agent loop changes**: The loop dispatches tools the same way. MCP tools are indistinguishable from local tools at the dispatch level.
- **`strict: false` for MCP tools**: MCP servers provide arbitrary JSON Schema that may contain nested objects without `additionalProperties: false`, optional fields, unions, etc. Recursively patching schemas to satisfy OpenAI strict mode is fragile. MCP tools register with `strict: false`. Local tools keep `strict: true`.
- **`maxTokens` on `ChatCompletionParams`**: The sampling handler needs to forward `maxTokens` from MCP requests. Add an optional `maxTokens` field to `ChatCompletionParams` and wire it through OpenAI and Gemini providers.
- **Tool call timeout**: Every `client.callTool()` is wrapped with `AbortSignal.timeout(config.limits.fetchTimeout)` (30s) to prevent hanging on unresponsive servers.
- **Per-agent filtering**: MCP tools are referenced by name in `.agent.md` `tools:` lists, same as local tools. An agent that doesn't list an MCP tool won't see it.
- **Fail-open on connection**: If an MCP server fails to connect at startup, log a warning and continue without its tools. Never block agent startup.
- **Fail-closed on dispatch**: If an MCP tool is called but its server is disconnected, return an error result (not a crash).
- **Sampling is optional**: The sampling handler is registered on every MCP client, but servers that don't use sampling just never invoke it.
- **Config is static and frozen**: MCP server definitions live in `src/config/` alongside existing config, loaded once at startup.

## Acceptance criteria

- [ ] A new config section `mcp.servers` in `src/config/` defines MCP servers with transport type, command/url, and optional env
- [ ] `mcpService.connect()` establishes connections to all configured servers at startup
- [ ] `mcpService.registerTools()` discovers tools from connected servers and registers them via `register()` in the tool registry
- [ ] MCP tools appear in `getTools()` and `getToolsByName()` output, indistinguishable from local tools
- [ ] An `.agent.md` file can list MCP tool names in its `tools:` array to include them, or omit them to exclude
- [ ] When the LLM calls an MCP tool, `dispatch()` routes to the MCP handler which calls `tools/call` on the correct server
- [ ] The handler maps the MCP server's response (content array with text/image/resource) back to `ToolResult`
- [ ] Stdio transport: a configured local command is spawned and communicated with via JSON-RPC over stdin/stdout
- [ ] SSE / Streamable HTTP transport: a configured URL is connected to via the MCP SDK's HTTP transport
- [ ] Sampling: when an MCP server sends a `sampling/createMessage` request, the client routes it through `llm.chatCompletion()` and returns the result
- [ ] If a configured server fails to connect, a warning is logged and the agent starts without that server's tools
- [ ] If a connected server disconnects mid-session, subsequent tool calls to its tools return error results
- [ ] `mcpService.disconnect()` cleanly shuts down all MCP clients (called in agent `finally` block)
- [ ] `bun test` passes without any MCP servers configured (zero-config baseline)
- [ ] MCP tools are registered with `strict: false` — their JSON Schema is passed through as-is from the server
- [ ] `ChatCompletionParams` has an optional `maxTokens` field, wired through OpenAI and Gemini providers
- [ ] Every `callTool()` invocation has a 30s timeout via `AbortSignal.timeout()`
- [ ] Stdio child processes are cleaned up on `process.on("exit")` as a safety net

## Implementation plan

### 1. Install MCP SDK

```bash
bun add @modelcontextprotocol/sdk
```

The SDK provides `Client`, `StdioClientTransport`, `SSEClientTransport`, and `StreamableHTTPClientTransport`.

### 2. Add `maxTokens` to `ChatCompletionParams`

**File**: `src/types/llm.ts`

Add optional `maxTokens` to the existing interface:

```typescript
export interface ChatCompletionParams {
  model: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  temperature?: number;
  maxTokens?: number;     // new — needed for sampling, useful generally
}
```

**Files**: `src/llm/openai.ts`, `src/llm/gemini.ts`

Wire `maxTokens` through to each provider's SDK call (OpenAI: `max_tokens`, Gemini: `maxOutputTokens`). When absent, omit the field (let the provider use its default).

### 3. Add MCP config

**File**: `src/config/mcp.ts` (new)

Define the MCP server configuration structure and load from a JSON file using `Bun.file()` directly (this is config loading, not tool I/O — the sandboxed `files` service is not appropriate here):

```typescript
interface McpStdioServer {
  transport: "stdio";
  command: string;        // e.g. "npx"
  args?: string[];        // e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  env?: Record<string, string>;
}

interface McpHttpServer {
  transport: "sse" | "http";
  url: string;            // e.g. "http://localhost:3001/mcp"
}

type McpServerConfig = (McpStdioServer | McpHttpServer) & {
  name: string;           // unique identifier, used as tool name prefix
  enabled?: boolean;      // default true; set false to disable without removing
};

interface McpConfig {
  servers: McpServerConfig[];
}
```

Config is loaded from `workspace/mcp.json` via `Bun.file()` (if it exists). If the file is absent, `servers` defaults to `[]`. This keeps MCP config separate from the frozen app config and easy to edit.

Example `workspace/mcp.json`:
```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    {
      "name": "brave",
      "transport": "sse",
      "url": "http://localhost:3002/sse"
    }
  ]
}
```

### 4. Create the MCP service

**File**: `src/infra/mcp.ts` (new)

This is the core module. It manages MCP client connections and exposes tools.

**Exports:**

- `createMcpService(llmProvider: LLMProvider): McpService`
- Interface:
  ```typescript
  interface McpService {
    connect(): Promise<void>;           // Connect to all configured servers
    registerTools(): Promise<void>;     // Discover and register tools from all connected servers
    disconnect(): Promise<void>;        // Clean shutdown of all clients
    getConnectedServers(): string[];    // List of connected server names
  }
  ```

**Connection flow** (`connect()`):

For each enabled server in config:
1. Create an MCP `Client` instance with capabilities: `{ sampling: {} }`
2. Create the appropriate transport (`StdioClientTransport` or `SSEClientTransport` / `StreamableHTTPClientTransport`)
3. Register the sampling handler on the client (see step 5)
4. Call `client.connect(transport)` wrapped in try/catch — on failure, log warning, skip server
5. Store in `Map<string, { client: Client, transport: Transport }>`

**Tool discovery** (`registerTools()`):

For each connected server:
1. Call `client.listTools()` to get the server's tool list
2. For each MCP tool, create a `ToolDefinition`:
   - `name`: `mcp_${serverName}_${toolName}` (prefixed to avoid collisions with local tools). Dots and hyphens in tool names normalized to underscores.
   - `schema`: Build a `SimpleToolSchema` from the MCP tool's JSON Schema. Since MCP tools already provide JSON Schema (not Zod), we need a thin adapter — create a `z.ZodObject` from the JSON Schema using `z.object()` with `z.any()` fields, but override `zodToParameters()` to return the original JSON Schema directly. **Alternative (simpler)**: register directly as `LLMTool` by adding a `registerRaw(name, handler, jsonSchema)` function to the registry that bypasses Zod conversion.
   - `handler`: Async function that calls `client.callTool({ name: mcpToolName, arguments: args })` with `AbortSignal.timeout(config.limits.fetchTimeout)` and maps the MCP response to `ToolResult`

**Response mapping** (MCP → ToolResult):

MCP tool results contain a `content` array with items of type `{ type: "text", text }`, `{ type: "image", data, mimeType }`, or `{ type: "resource", resource: { uri, text?, blob? } }`. Map these 1:1 to our `ContentPart` types (`TextPart`, `ImagePart`, `ResourceRef`).

If `result.isError` is true, set `isError: true` on the `ToolResult`.

### 5. Add `registerRaw()` to registry

**File**: `src/tools/registry.ts`

Add a new function that registers a tool with a pre-built JSON Schema, bypassing Zod conversion. MCP schemas are passed through as-is with `strict: false`:

```typescript
export function registerRaw(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<ToolResult>,
): void {
  if (handlers.has(name)) {
    throw new Error(`Duplicate tool registration: "${name}"`);
  }

  // Store a lightweight ToolDefinition for dispatch routing
  handlers.set(name, { name, schema: { name, description, schema: {} as any }, handler });

  // Pass MCP schema through as-is — no patching, no strict mode.
  // MCP servers provide arbitrary JSON Schema that may not satisfy
  // OpenAI strict requirements (nested objects, optional fields, unions).
  expandedTools.push({
    type: "function",
    function: {
      name,
      description,
      parameters,
      strict: false,
    },
  });
}
```

This avoids the Zod ↔ JSON Schema round-trip entirely. MCP servers already provide JSON Schema — converting to Zod and back would be lossy and fragile. Using `strict: false` is the honest approach — we can't guarantee arbitrary external schemas are strict-compatible.

### 6. Implement sampling handler

**Inside `src/infra/mcp.ts`**, when creating each MCP client:

```typescript
client.setRequestHandler(SamplingCreateMessageRequestSchema, async (request) => {
  // Map MCP messages → LLMMessage[]
  const messages: LLMMessage[] = request.params.messages.map(msg => ({
    role: msg.role as "user" | "assistant",
    content: typeof msg.content === "string"
      ? msg.content
      : msg.content.type === "text"
        ? msg.content.text
        : `[${msg.content.type}]`,
  }));

  // Add system prompt if provided
  if (request.params.systemPrompt) {
    messages.unshift({ role: "system", content: request.params.systemPrompt });
  }

  // Route through our LLM layer (maxTokens is now supported on ChatCompletionParams)
  const response = await llmProvider.chatCompletion({
    model: request.params.modelPreferences?.hints?.[0]?.name
      ?? config.models.agent,   // fallback to default model
    messages,
    maxTokens: request.params.maxTokens,
  });

  return {
    model: request.params.modelPreferences?.hints?.[0]?.name ?? config.models.agent,
    role: "assistant" as const,
    content: {
      type: "text" as const,
      text: response.content ?? "",
    },
  };
});
```

This gives MCP servers access to the same LLM routing layer the agent uses. The server can suggest a model via `modelPreferences.hints`, but we route it through our provider registry — if the model isn't available, the registry throws as usual.

### 7. Wire into startup

MCP connections are established **once at process startup**, not per agent run. This matches how local tools are registered at module import time and avoids duplicate registration issues across multiple `runAgent()` calls.

**File**: `src/tools/index.ts`

Add MCP tool registration after local tools:

```typescript
import { createMcpService } from "../infra/mcp.ts";
import { llm } from "../llm/llm.ts";

// ... existing local tool registrations ...

const mcpService = createMcpService(llm);

export async function initMcpTools(): Promise<void> {
  await mcpService.connect();
  await mcpService.registerTools();
}

export async function shutdownMcp(): Promise<void> {
  await mcpService.disconnect();
}

export { mcpService };
```

**Files**: `src/cli.ts`, `src/server.ts`

Call `initMcpTools()` at process startup, before any agent runs. Call `shutdownMcp()` at process exit:

```typescript
import { initMcpTools, shutdownMcp } from "./tools/index.ts";

// At startup, after local tools are registered:
await initMcpTools();

// At process exit:
process.on("beforeExit", async () => { await shutdownMcp(); });
```

**The agent loop (`src/agent/loop.ts`) is NOT modified.** By the time `runAgent()` executes, MCP tools are already in the registry and available via `getTools()` / `getToolsByName()`.

**Zombie process safety net**: Register a sync `process.on("exit")` handler that kills any stdio child processes. This covers hard crashes and unhandled rejections where `shutdownMcp()` wouldn't run:

```typescript
// Inside mcpService, track child processes
const childProcesses: Set<ChildProcess> = new Set();

process.on("exit", () => {
  for (const child of childProcesses) {
    child.kill();
  }
});
```

### 8. Agent filtering — no changes needed

The existing filtering in `src/agent/agents.ts` already works:

```typescript
// agents.ts line 113
const tools = agent.tools
  ? resolveTools(agent.name, agent.tools)  // filters by name
  : await getTools();                       // all tools
```

An `.agent.md` that wants MCP tools just lists them:

```yaml
---
name: researcher
model: gpt-4.1
tools: [think, web, mcp_brave_search, mcp_filesystem_read_file]
---
```

If an agent doesn't list MCP tools, they're excluded. If no `tools:` key is specified, all tools (including MCP) are available.

**Note on filtering granularity**: MCP tools are always flat (no multi-action `__` separator). Each tool from each server is a separate entry. Agents must list individual MCP tool names (`mcp_brave_search`), not server-level prefixes (`mcp_brave`). This is intentional — it gives agents precise control over which capabilities they expose.

### 9. Error handling

**Connection failure**: Caught in `connect()`, logged as warning, server skipped. Other servers still connect.

**Server disconnect mid-session**: The MCP SDK's `Client` tracks connection state. The tool handler checks `client.isConnected()` (or equivalent) before calling `callTool()`. If disconnected, returns `error("MCP server '${serverName}' is disconnected")`.

**Tool call failure**: MCP `callTool()` can throw or return `{ isError: true }`. Both cases are mapped to `ToolResult` with `isError: true`. The dispatch layer already handles this.

**Sampling failure**: If the LLM call in the sampling handler fails, the error propagates back to the MCP server as an MCP error response. The server decides what to do.

### Expected tool naming

| MCP Server | MCP Tool Name | Registered As |
|---|---|---|
| `filesystem` | `read_file` | `mcp_filesystem_read_file` |
| `filesystem` | `write_file` | `mcp_filesystem_write_file` |
| `brave` | `search` | `mcp_brave_search` |

The `mcp_` prefix makes MCP tools immediately recognizable in logs and agent configs. The server name provides namespace isolation (two servers can both have a `search` tool).

### Files modified (summary)

| File | Change |
|---|---|
| `package.json` | Add `@modelcontextprotocol/sdk` dependency |
| `src/types/llm.ts` | Add optional `maxTokens` to `ChatCompletionParams` |
| `src/llm/openai.ts` | Wire `maxTokens` → `max_tokens` |
| `src/llm/gemini.ts` | Wire `maxTokens` → `maxOutputTokens` |
| `src/config/mcp.ts` | **New** — MCP server config types + loader (via `Bun.file()`) |
| `src/infra/mcp.ts` | **New** — MCP client service (connect, discover, sampling, disconnect, zombie cleanup) |
| `src/tools/registry.ts` | Add `registerRaw()` for JSON Schema tools (`strict: false`) |
| `src/tools/index.ts` | Add `initMcpTools()`, `shutdownMcp()` exports |
| `src/cli.ts` | Call `initMcpTools()` at startup, `shutdownMcp()` on exit |
| `src/server.ts` | Call `initMcpTools()` at startup, `shutdownMcp()` on exit |
| `workspace/mcp.json` | **New** — example MCP server config |

## Testing scenarios

1. **No MCP config (default)**: `workspace/mcp.json` absent or `servers: []`. Run `bun test` — all existing tests pass. Run `bun run agent "hello"` — agent works normally. No MCP-related output.

2. **Stdio server**: Configure a local MCP server (e.g. `@modelcontextprotocol/server-filesystem`). Run agent with a prompt that triggers the tool. Verify:
   - Tool appears in the agent's tool list
   - Tool call succeeds and returns file contents
   - Log shows MCP tool dispatch

3. **SSE/HTTP server**: Configure a remote MCP server URL. Verify connection, tool discovery, and dispatch work over HTTP.

4. **Sampling**: Configure an MCP server that uses sampling (requests LLM completions). Verify:
   - Sampling callback fires and routes through `llm.chatCompletion()`
   - Server receives the LLM response and completes its tool execution
   - Final tool result reaches the agent

5. **Connection failure**: Configure a server with a bad command/URL. Verify:
   - Warning logged at startup
   - Agent starts normally without that server's tools
   - Other configured servers still connect

6. **Mid-session disconnect**: Kill an MCP server process during an agent run. Verify:
   - Next tool call to that server returns an error result
   - Agent continues with other tools
   - No crash

7. **Agent filtering**: Configure two agents — one with MCP tools in its `tools:` list, one without. Verify each agent sees only its configured tools.

8. **Name collision prevention**: Register a local tool and an MCP tool. Verify the `mcp_` prefix prevents name collisions. Verify `registerRaw()` throws on duplicate names.

9. **Tool call timeout**: Configure an MCP server that sleeps >30s on a tool call. Verify the call aborts with a timeout error, not a hang.

10. **Unit tests** (`src/infra/mcp.test.ts`):
   - `registerRaw()` produces valid `LLMTool` entries with `strict: false`
   - MCP response mapping (text, image, resource, error) → `ToolResult`
   - Config loader returns empty array when file is missing
   - Sampling handler maps MCP messages → LLM messages correctly (including `maxTokens` passthrough)