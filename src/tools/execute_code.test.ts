import { describe, test, expect, mock } from "bun:test";
import { join, resolve } from "path";
import { mkdir } from "fs/promises";
import executeCode from "./execute_code.ts";

// Mock getSessionId to return a test session
const mockSessionId = "test-session-code-001";
mock.module("../agent/context.ts", () => ({
  getSessionId: () => mockSessionId,
  getAgentName: () => "default",
  requireSessionId: () => mockSessionId,
}));

// Resolve session dir for test setup
import { config } from "../config/index.ts";
const sessionDir = resolve(
  join(
    config.paths.sessionsDir,
    new Date().toISOString().slice(0, 10),
    mockSessionId,
  ),
);

describe("execute_code", () => {
  test("executes simple code and captures stdout", async () => {
    const result = await executeCode.handler({
      code: `console.log("hello world");`,
      description: "print hello",
    });
    expect(result.text).toContain("hello world");
  });

  test("captures JSON output", async () => {
    const result = await executeCode.handler({
      code: `console.log(JSON.stringify({ count: 42, items: [1, 2, 3] }));`,
      description: "output JSON",
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(42);
    expect(parsed.items).toEqual([1, 2, 3]);
  });

  test("injects SESSION_DIR constant", async () => {
    const result = await executeCode.handler({
      code: `console.log(typeof SESSION_DIR);`,
      description: "check SESSION_DIR",
    });
    expect(result.text.trim()).toBe("string");
  });

  test("tools.writeFile and tools.readFile round-trip through bridge", async () => {
    const result = await executeCode.handler({
      code: `
        const testPath = SESSION_DIR + "/bridge_test.txt";
        await tools.writeFile(testPath, "bridge works!");
        const content = await tools.readFile(testPath);
        console.log(content);
      `,
      description: "bridge round-trip test",
    });
    expect(result.text).toContain("bridge works!");
  });

  test("tools.readJson parses JSON through bridge", async () => {
    const result = await executeCode.handler({
      code: `
        const testPath = SESSION_DIR + "/bridge_data.json";
        await tools.writeFile(testPath, JSON.stringify({ key: "value", num: 99 }));
        const data = await tools.readJson(testPath);
        console.log(data.key, data.num);
      `,
      description: "bridge readJson test",
    });
    expect(result.text).toContain("value");
    expect(result.text).toContain("99");
  });

  test("tools.listDir lists session directory entries", async () => {
    // Ensure a file exists
    await mkdir(sessionDir, { recursive: true });
    await Bun.write(join(sessionDir, "_list_test.txt"), "x");

    const result = await executeCode.handler({
      code: `
        const entries = await tools.listDir(SESSION_DIR);
        console.log(JSON.stringify(entries.filter(e => e.includes("_list_test"))));
      `,
      description: "bridge listDir test",
    });
    expect(result.text).toContain("_list_test.txt");
  });

  test("bridge blocks access outside session dir", async () => {
    const result = await executeCode.handler({
      code: `
        try {
          await tools.readFile("/etc/passwd");
          console.log("SHOULD NOT REACH");
        } catch (err) {
          console.log("BLOCKED: " + err.message);
        }
      `,
      description: "bridge access control test",
    });
    expect(result.text).toContain("BLOCKED");
    expect(result.text).toContain("Access denied");
    expect(result.text).not.toContain("SHOULD NOT REACH");
  });

  test("bridge blocks reading workspace/project files", async () => {
    const result = await executeCode.handler({
      code: `
        try {
          // Try to read the agent's own source code
          await tools.readFile(SESSION_DIR + "/../../../package.json");
          console.log("SHOULD NOT REACH");
        } catch (err) {
          console.log("BLOCKED: " + err.message);
        }
      `,
      description: "bridge project file access test",
    });
    expect(result.text).toContain("BLOCKED");
    expect(result.text).not.toContain("SHOULD NOT REACH");
  });

  test("sanitizes absolute paths from output", async () => {
    const result = await executeCode.handler({
      code: `console.log(SESSION_DIR);`,
      description: "path sanitization test",
    });
    expect(result.text).toContain("./");
    expect(result.text).not.toContain(mockSessionId);
  });

  test("does not pass API keys to subprocess", async () => {
    const result = await executeCode.handler({
      code: `
        const envKeys = Object.keys(process.env);
        const sensitive = envKeys.filter(k =>
          k.includes("API") || k.includes("KEY") || k.includes("SECRET") || k.includes("TOKEN")
        );
        console.log(JSON.stringify(sensitive));
      `,
      description: "env isolation test",
    });
    const leaked = JSON.parse(result.text);
    expect(leaked.length).toBe(0);
  });

  test("captures stderr", async () => {
    const result = await executeCode.handler({
      code: `console.error("warning"); console.log("ok");`,
      description: "stderr test",
    });
    expect(result.text).toContain("ok");
    expect(result.text).toContain("warning");
  });

  test("reports non-zero exit code", async () => {
    const result = await executeCode.handler({
      code: `process.exit(1);`,
      description: "exit code test",
    });
    expect(result.text).toContain("exit code 1");
  });

  test("rejects missing code parameter", async () => {
    await expect(
      executeCode.handler({ description: "no code" }),
    ).rejects.toThrow("code parameter is required");
  });

  test("rejects missing description", async () => {
    await expect(
      executeCode.handler({ code: "console.log(1)" }),
    ).rejects.toThrow("description parameter is required");
  });

  test("rejects code exceeding max length", async () => {
    const longCode = "x".repeat(100_001);
    await expect(
      executeCode.handler({ code: longCode, description: "too long" }),
    ).rejects.toThrow("exceeds maximum");
  });

  test("respects timeout", async () => {
    const start = Date.now();
    const result = await executeCode.handler({
      code: `await new Promise(r => setTimeout(r, 60000));`,
      description: "timeout test",
      timeout: 2000,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(
      result.text.includes("timed out") || result.text.includes("exit code"),
    ).toBe(true);
  }, 10_000);

  test("cleans up temp file after execution", async () => {
    const { readdir } = await import("fs/promises");

    await executeCode.handler({
      code: `console.log("cleanup test");`,
      description: "cleanup test",
    });

    const files = await readdir(sessionDir).catch(() => []);
    const execFiles = (files as string[]).filter((f: string) =>
      f.startsWith("_exec_"),
    );
    expect(execFiles.length).toBe(0);
  });
});
