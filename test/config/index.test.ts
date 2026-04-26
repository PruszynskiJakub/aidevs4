import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { config } from "../../src/config/index.ts";

// For subprocess tests — avoids depending on config for cwd
const PROJECT_ROOT = resolve(import.meta.dir, "../..");

describe("config module", () => {
  it("exports config with all expected top-level groups", () => {
    expect(config.paths).toBeDefined();
    expect(config.sandbox).toBeDefined();
    expect(config.models).toBeDefined();
    expect(config.hub).toBeDefined();
    expect(config.keys).toBeDefined();
    expect(config.limits).toBeDefined();
    expect(config.server).toBeDefined();
  });

  it("has correct static values", () => {
    expect(config.models.agent).toBe("gpt-4.1");
    expect(config.models.transform).toBe("gpt-4.1-mini");
    expect(config.models.gemini).toBe("gemini-3-flash-preview");
    expect(config.limits.maxIterations).toBe(40);
    expect(config.limits.fetchTimeout).toBe(30_000);
    expect(config.limits.maxBatchRows).toBe(1000);
    expect(config.limits.maxFileSize).toBe(10 * 1024 * 1024);
    expect(config.limits.transformBatchSize).toBe(25);
    expect(config.limits.geminiTimeout).toBe(60_000);
    expect(config.limits.docMaxFiles).toBe(10);
    expect(config.hub.baseUrl).toBe("https://hub.ag3nts.org");
    expect(config.hub.verifyUrl).toBe("https://hub.ag3nts.org/verify");
    expect(config.sandbox.webAllowedHosts).toEqual([".ag3nts.org"]);
  });

  it("resolves projectRoot to the repo root", () => {
    const expected = resolve(import.meta.dir, "../..");
    expect(config.paths.projectRoot).toBe(expected);
  });

  it("reads HUB_API_KEY from env", () => {
    expect(typeof config.hub.apiKey).toBe("string");
    expect(config.hub.apiKey.length).toBeGreaterThan(0);
  });

  it("server.port is a valid number", () => {
    expect(typeof config.server.port).toBe("number");
    expect(config.server.port).toBeGreaterThanOrEqual(1);
  });

  it("geminiApiKey is string or undefined", () => {
    expect(
      config.keys.geminiApiKey === undefined ||
      typeof config.keys.geminiApiKey === "string",
    ).toBe(true);
  });

  it("throws TypeError when mutating a top-level property", () => {
    expect(() => {
      (config as any).persona = "hacked";
    }).toThrow();
  });

  it("throws TypeError when mutating a nested property", () => {
    expect(() => {
      (config.limits as any).maxIterations = 99;
    }).toThrow();
  });

  it("throws TypeError when pushing to a frozen array", () => {
    expect(() => {
      (config.sandbox.allowedReadPaths as string[]).push("/tmp");
    }).toThrow();
  });
});

describe("config validation (subprocess)", () => {
  it("throws when HUB_API_KEY is missing", async () => {
    const proc = Bun.spawn(
      ["bun", "-e", "await import('./src/config/index.ts')"],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, HUB_API_KEY: "" },
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Missing required environment variable");
    expect(stderr).toContain("HUB_API_KEY");
  });

  it("throws when OPENAI_API_KEY is missing", async () => {
    const proc = Bun.spawn(
      ["bun", "-e", "await import('./src/config/index.ts')"],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, OPENAI_API_KEY: "" },
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Missing required environment variable");
    expect(stderr).toContain("OPENAI_API_KEY");
  });

  it("lists all missing vars when multiple are absent", async () => {
    const proc = Bun.spawn(
      ["bun", "-e", "await import('./src/config/index.ts')"],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, HUB_API_KEY: "", OPENAI_API_KEY: "" },
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("HUB_API_KEY");
    expect(stderr).toContain("OPENAI_API_KEY");
  });
});
