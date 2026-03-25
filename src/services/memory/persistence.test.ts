import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { saveState, loadState, saveDebugArtifact } from "./persistence.ts";
import { emptyMemoryState } from "../../types/memory.ts";
import { join } from "node:path";
import { config } from "../../config/index.ts";
import { rmSync, existsSync, readFileSync, readdirSync } from "node:fs";

const TEST_SESSION = "test-persistence-" + Date.now();
const sessionDir = join(config.paths.outputDir, TEST_SESSION);

afterEach(() => {
  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch {}
});

describe("saveState / loadState", () => {
  test("round-trips memory state", async () => {
    const state = {
      activeObservations: "🔴 Critical finding",
      lastObservedIndex: 5,
      observationTokenCount: 100,
      generationCount: 1,
    };

    await saveState(TEST_SESSION, state);
    const loaded = await loadState(TEST_SESSION);

    expect(loaded).toEqual(state);
  });

  test("returns null for nonexistent session", async () => {
    const result = await loadState("nonexistent-session-xyz");
    expect(result).toBeNull();
  });
});

describe("saveDebugArtifact", () => {
  test("creates numbered markdown files with frontmatter", async () => {
    await saveDebugArtifact(TEST_SESSION, "observer", "Some observations", {
      tokensBefore: 0,
      tokensAfter: 100,
    });

    const files = readdirSync(sessionDir).filter((f) => f.startsWith("observer-"));
    expect(files.length).toBe(1);
    expect(files[0]).toBe("observer-001.md");

    const content = readFileSync(join(sessionDir, files[0]), "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("tokensBefore");
    expect(content).toContain("Some observations");
  });

  test("increments sequence number", async () => {
    await saveDebugArtifact(TEST_SESSION, "reflector", "First", { level: 0 });
    await saveDebugArtifact(TEST_SESSION, "reflector", "Second", { level: 1 });

    const files = readdirSync(sessionDir)
      .filter((f) => f.startsWith("reflector-"))
      .sort();
    expect(files.length).toBe(2);
    expect(files[0]).toBe("reflector-001.md");
    expect(files[1]).toBe("reflector-002.md");
  });
});
