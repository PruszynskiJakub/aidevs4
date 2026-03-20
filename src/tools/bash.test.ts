import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { config } from "../config/index.ts";
import bash from "./bash.ts";

describe("bash tool", () => {
  it("executes a simple command", async () => {
    const result = await bash.handler({ command: "echo hello" });
    expect(result).toBe("hello");
  });

  it("reports non-zero exit codes without throwing", async () => {
    const result = await bash.handler({ command: "exit 42" });
    expect(result).toContain("[exit code 42]");
  });

  it("truncates output longer than 20,000 characters with ToolResponse hint", async () => {
    const result = (await bash.handler({ command: "seq 1 100000" })) as any;
    // When truncated, bash returns a ToolResponse with hint
    expect(result.status).toBe("ok");
    expect(result.data).toEndWith("...(truncated)");
    expect(result.hints).toContain("Output truncated to 20 KB. Full output not available.");
  });

  it("runs with CWD set to output directory", async () => {
    const result = await bash.handler({ command: "pwd" });
    expect(result).toBe(resolve(config.paths.outputDir));
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
    expect(result).toBe("hi");
  });

  it("allows /dev/null redirects", async () => {
    const result = await bash.handler({ command: "echo hi > /dev/null" });
    expect(result).toBe("(no output)");
  });
});
