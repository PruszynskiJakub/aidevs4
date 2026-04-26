import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { config } from "../../src/config/index.ts";
import type { ToolResult } from "../../src/types/tool-result.ts";
import bash from "../../src/tools/bash.ts";

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

describe("bash tool", () => {
  it("executes a simple command", async () => {
    const result = await bash.handler({ command: "echo hello" });
    expect(getText(result)).toBe("hello");
  });

  it("reports non-zero exit codes without throwing", async () => {
    const result = await bash.handler({ command: "exit 42" });
    expect(getText(result)).toContain("[exit code 42]");
  });

  it("truncates output longer than 20,000 characters", async () => {
    const result = await bash.handler({ command: "seq 1 100000" });
    expect(getText(result)).toEndWith("...(truncated)");
  });

  it("runs with CWD set to sessions directory", async () => {
    const result = await bash.handler({ command: "pwd" });
    expect(getText(result)).toBe(resolve(config.paths.sessionsDir));
  });

  it("blocks redirect writes to absolute paths outside session dir", async () => {
    await expect(
      bash.handler({ command: "echo hi > /tmp/evil.txt" }),
    ).rejects.toThrow("outside the session output directory");
  });

  it("blocks append redirects outside session dir", async () => {
    await expect(
      bash.handler({ command: "echo hi >> /tmp/evil.txt" }),
    ).rejects.toThrow("outside the session output directory");
  });

  it("blocks tee writes outside session dir", async () => {
    await expect(
      bash.handler({ command: "echo hi | tee /tmp/evil.txt" }),
    ).rejects.toThrow("outside the session output directory");
  });

  it("blocks path traversal via ../", async () => {
    await expect(
      bash.handler({ command: "echo hi > ../../etc/evil.txt" }),
    ).rejects.toThrow("outside the session output directory");
  });

  it("allows redirects to relative paths within cwd", async () => {
    const result = await bash.handler({ command: "echo hi > test_output.txt && cat test_output.txt" });
    expect(getText(result)).toBe("hi");
  });

  it("allows /dev/null redirects", async () => {
    const result = await bash.handler({ command: "echo hi > /dev/null" });
    expect(getText(result)).toBe("(no output)");
  });

  it("returns ToolResult with text content", async () => {
    const result = await bash.handler({ command: "echo test" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(getText(result)).toBe("test");
  });

  it("accepts description parameter without affecting execution", async () => {
    const result = await bash.handler({
      command: "echo hello",
      description: "Test echo command",
      timeout: 30000,
    });
    expect(getText(result)).toBe("hello");
  });

  it("enforces timeout on long-running commands", async () => {
    await expect(
      bash.handler({ command: "sleep 10", description: "sleep test", timeout: 1000 }),
    ).rejects.toThrow("timed out");
  }, 5000);

  it("clamps timeout below 1000 to 1000", async () => {
    const result = await bash.handler({
      command: "echo fast",
      description: "fast command",
      timeout: 100,
    });
    expect(getText(result)).toBe("fast");
  });

  it("defaults timeout to 30000 when not provided", async () => {
    const result = await bash.handler({ command: "echo ok" });
    expect(getText(result)).toBe("ok");
  });
});
