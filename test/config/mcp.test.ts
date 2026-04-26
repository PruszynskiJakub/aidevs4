import { describe, test, expect } from "bun:test";
import { loadMcpConfig } from "../../src/config/mcp.ts";

describe("loadMcpConfig", () => {
  test("returns empty servers array when mcp.json does not exist", async () => {
    // Default workspace/mcp.json doesn't exist in test environment
    const config = await loadMcpConfig();
    expect(config.servers).toEqual([]);
  });
});
