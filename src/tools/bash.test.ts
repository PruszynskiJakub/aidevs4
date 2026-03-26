import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { config } from "../config/index.ts";
import type { Document } from "../types/document.ts";
import bash from "./bash.ts";

describe("bash tool", () => {
  it("executes a simple command", async () => {
    const result = await bash.handler({ command: "echo hello" }) as Document;
    expect(result.text).toBe("hello");
    expect(result.metadata.type).toBe("document");
  });

  it("reports non-zero exit codes without throwing", async () => {
    const result = await bash.handler({ command: "exit 42" }) as Document;
    expect(result.text).toContain("[exit code 42]");
  });

  it("truncates output longer than 20,000 characters", async () => {
    const result = await bash.handler({ command: "seq 1 100000" }) as Document;
    expect(result.text).toEndWith("...(truncated)");
  });

  it("runs with CWD set to sessions directory", async () => {
    const result = await bash.handler({ command: "pwd" }) as Document;
    expect(result.text).toBe(resolve(config.paths.sessionsDir));
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
    const result = await bash.handler({ command: "echo hi > test_output.txt && cat test_output.txt" }) as Document;
    expect(result.text).toBe("hi");
  });

  it("allows /dev/null redirects", async () => {
    const result = await bash.handler({ command: "echo hi > /dev/null" }) as Document;
    expect(result.text).toBe("(no output)");
  });

  it("returns Document with correct metadata", async () => {
    const result = await bash.handler({ command: "echo test" }) as Document;
    expect(result.uuid).toBeTruthy();
    expect(result.description).toContain("Bash output for:");
    expect(result.metadata.source).toBeNull();
    expect(result.metadata.type).toBe("document");
    expect(result.metadata.mimeType).toBe("text/plain");
    expect(result.metadata.tokens).toBeGreaterThan(0);
  });

  it("accepts description parameter without affecting execution", async () => {
    const result = await bash.handler({
      command: "echo hello",
      description: "Test echo command",
      timeout: 30000,
    }) as Document;
    expect(result.text).toBe("hello");
  });

  it("enforces timeout on long-running commands", async () => {
    await expect(
      bash.handler({ command: "sleep 10", description: "sleep test", timeout: 1000 }),
    ).rejects.toThrow("timed out");
  }, 5000);

  it("clamps timeout below 1000 to 1000", async () => {
    // Should not throw immediately — timeout is clamped up to 1000ms
    const result = await bash.handler({
      command: "echo fast",
      description: "fast command",
      timeout: 100,
    }) as Document;
    expect(result.text).toBe("fast");
  });

  it("defaults timeout to 30000 when not provided", async () => {
    // Just verify it runs without error (not actually waiting 30s)
    const result = await bash.handler({ command: "echo ok" }) as Document;
    expect(result.text).toBe("ok");
  });
});
