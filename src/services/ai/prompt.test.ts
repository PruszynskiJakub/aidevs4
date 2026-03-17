import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createPromptService } from "./prompt.ts";
import { _testReadPaths } from "../common/file.ts";

let tmp: string;
let service: ReturnType<typeof createPromptService>;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "prompt-service-test-"));
  _testReadPaths.push(tmp);
  service = createPromptService(tmp);

  await Bun.write(
    join(tmp, "full.md"),
    `---
model: gpt-4.1
temperature: 0.7
---
Hello {{name}}, welcome to {{place}}.`,
  );

  await Bun.write(
    join(tmp, "no-frontmatter.md"),
    "Just plain content, no frontmatter.",
  );

  await Bun.write(
    join(tmp, "no-vars.md"),
    `---
model: gpt-4.1-mini
---
Static prompt with no placeholders.`,
  );

  await Bun.write(
    join(tmp, "model-only.md"),
    `---
model: gpt-4.1
---
Only model in frontmatter.`,
  );
});

afterAll(async () => {
  _testReadPaths.splice(_testReadPaths.indexOf(tmp), 1);
  await rm(tmp, { recursive: true, force: true });
});

describe("PromptService", () => {
  it("parses frontmatter and replaces placeholders", async () => {
    const result = await service.load("full", {
      name: "Alice",
      place: "Wonderland",
    });
    expect(result.model).toBe("gpt-4.1");
    expect(result.temperature).toBe(0.7);
    expect(result.content).toBe("Hello Alice, welcome to Wonderland.");
  });

  it("throws on missing placeholder variable", async () => {
    expect(service.load("full", { name: "Alice" })).rejects.toThrow(
      "Missing placeholder variable: {{place}}",
    );
  });

  it("throws on no variables when placeholders exist", async () => {
    expect(service.load("full")).rejects.toThrow(
      "Missing placeholder variable:",
    );
  });

  it("returns content with no frontmatter", async () => {
    const result = await service.load("no-frontmatter");
    expect(result.model).toBeUndefined();
    expect(result.temperature).toBeUndefined();
    expect(result.content).toBe("Just plain content, no frontmatter.");
  });

  it("ignores extra variables", async () => {
    const result = await service.load("full", {
      name: "Bob",
      place: "Berlin",
      unused: "ignored",
    });
    expect(result.content).toBe("Hello Bob, welcome to Berlin.");
  });

  it("handles optional temperature in frontmatter", async () => {
    const result = await service.load("model-only");
    expect(result.model).toBe("gpt-4.1");
    expect(result.temperature).toBeUndefined();
    expect(result.content).toBe("Only model in frontmatter.");
  });

  it("loads prompt with no placeholders and no variables", async () => {
    const result = await service.load("no-vars");
    expect(result.model).toBe("gpt-4.1-mini");
    expect(result.content).toBe("Static prompt with no placeholders.");
  });

  it("throws on non-existent prompt file", async () => {
    expect(service.load("nonexistent")).rejects.toThrow();
  });
});
