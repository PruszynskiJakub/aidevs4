import { register, registerRaw, getTools, getToolsByName, dispatch, reset } from "./registry.ts";
import { createMcpService } from "../infra/mcp.ts";
import { llm } from "../llm/llm.ts";

import think from "./think.ts";
import bash from "./bash.ts";
import agents_hub from "./agents_hub.ts";
import web from "./web.ts";
import geo_distance from "./geo_distance.ts";
import shipping from "./shipping.ts";
import document_processor from "./document_processor.ts";
import prompt_engineer from "./prompt_engineer.ts";
import read_file from "./read_file.ts";
import write_file from "./write_file.ts";
import edit_file from "./edit_file.ts";
import glob from "./glob.ts";
import grep from "./grep.ts";
import execute_code from "./execute_code.ts";
import delegate from "./delegate.ts";
import browser from "./browser.ts";

register(think);
register(bash);
register(agents_hub);
register(web);
register(geo_distance);
register(shipping);
register(document_processor);
register(prompt_engineer);
register(read_file);
register(write_file);
register(edit_file);
register(glob);
register(grep);
register(execute_code);
register(delegate);
register(browser);

// Keep reference on globalThis so hot reload (bun --hot) can disconnect the
// previous instance before creating a new one, preventing "Already connected
// to a transport" errors on the MCP server side.
const g = globalThis as Record<string, unknown>;
if (g.__mcpService) {
  (g.__mcpService as McpService).disconnect().catch(() => {});
}
const mcpService = createMcpService(llm);
g.__mcpService = mcpService;

export async function initMcpTools(): Promise<void> {
  await mcpService.connect();
  await mcpService.registerTools();
}

export async function shutdownMcp(): Promise<void> {
  await mcpService.disconnect();
}

export { register, registerRaw, getTools, getToolsByName, dispatch, reset, mcpService };
