import { describe, test, expect } from "bun:test";
import { loadMcpConfig } from "../../src/config/mcp.ts";

describe("loadMcpConfig", () => {
  test("loads servers from workspace/system/mcp.json", async () => {
    const config = await loadMcpConfig();
    expect(config.servers).toBeInstanceOf(Array);
    expect(config.servers.length).toBeGreaterThanOrEqual(0);
  });
});
