import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createSessionService, sessionService } from "../../src/agent/session.ts";
import { inferCategory } from "../../src/utils/media-types.ts";
import { createBunFileService, _setFilesForTest } from "../../src/infra/file.ts";
import { config } from "../../src/config/index.ts";
import { runWithContext } from "../../src/agent/context.ts";
import type { AgentState } from "../../src/types/agent-state.ts";
import type { Logger } from "../../src/types/logger.ts";
import { emptyMemoryState } from "../../src/types/memory.ts";

const noopLog = new Proxy({} as Logger, { get: () => () => {} });

function makeState(sessionId: string): AgentState {
  return {
    sessionId,
    messages: [],
    tokens: { promptTokens: 0, completionTokens: 0 },
    iteration: 0,
    assistant: "default",
    model: "",
    tools: [],
    memory: emptyMemoryState(),
  };
}

function withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(makeState(sessionId), noopLog, fn);
}

beforeEach(() => {
  sessionService._clear();
});

describe("sessionService", () => {
  it("creates a new session on getOrCreate", () => {
    const session = sessionService.getOrCreate("s1");
    expect(session.id).toBe("s1");
    expect(session.messages).toEqual([]);
    expect(session.createdAt).toBeInstanceOf(Date);
  });

  it("returns the same session on repeated getOrCreate", () => {
    const a = sessionService.getOrCreate("s1");
    const b = sessionService.getOrCreate("s1");
    expect(a).toBe(b);
  });

  it("appends messages and updates timestamp", async () => {
    sessionService.getOrCreate("s1");
    const before = sessionService.getOrCreate("s1").updatedAt;

    await new Promise((r) => setTimeout(r, 5));

    sessionService.appendMessage("s1", { role: "user", content: "hi" });
    const session = sessionService.getOrCreate("s1");
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(session.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("getMessages returns session messages", () => {
    sessionService.appendMessage("s1", { role: "user", content: "a" });
    sessionService.appendMessage("s1", { role: "user", content: "b" });
    const msgs = sessionService.getMessages("s1");
    expect(msgs).toHaveLength(2);
  });

  it("serializes tasks on the same session", async () => {
    const order: number[] = [];

    const p1 = sessionService.enqueue("s1", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });

    const p2 = sessionService.enqueue("s1", async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("runs tasks for different sessions concurrently", async () => {
    const order: string[] = [];

    const p1 = sessionService.enqueue("s1", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("s1");
    });

    const p2 = sessionService.enqueue("s2", async () => {
      order.push("s2");
    });

    await Promise.all([p1, p2]);
    // s2 should finish first because it doesn't sleep
    expect(order).toEqual(["s2", "s1"]);
  });
});

// --------------- inferCategory ---------------

describe("inferCategory", () => {
  it("returns 'image' for image extensions", () => {
    expect(inferCategory("photo.png")).toBe("image");
    expect(inferCategory("photo.jpg")).toBe("image");
  });

  it("returns 'audio' for audio extensions", () => {
    expect(inferCategory("song.mp3")).toBe("audio");
  });

  it("returns 'video' for video extensions", () => {
    expect(inferCategory("clip.mp4")).toBe("video");
  });

  it("returns 'text' for text-based extensions", () => {
    expect(inferCategory("data.csv")).toBe("text");
  });

  it("returns 'document' for unknown extensions", () => {
    expect(inferCategory("archive.xyz")).toBe("document");
  });
});

// --------------- outputPath ---------------

describe("outputPath", () => {
  let tmp: string;
  let restoreFiles: () => void;
  let svc: ReturnType<typeof createSessionService>;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "output-test-"));
    const customFiles = createBunFileService(
      [...config.sandbox.allowedReadPaths, tmp],
      [...config.sandbox.allowedWritePaths, tmp],
    );
    restoreFiles = _setFilesForTest(customFiles);
    svc = createSessionService(customFiles, tmp);
  });

  afterAll(async () => {
    restoreFiles();
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns flat path: {sessionsDir}/{date}/{sessionId}/{agentName}/output/{uuid}.{ext}", async () => {
    const result = await svc.outputPath("report.csv");

    const parts = result.split("/");
    const filename = parts.pop()!;
    const output = parts.pop()!;
    const agentName = parts.pop()!;

    // filename is {uuid}.csv
    expect(filename).toMatch(/^[0-9a-f-]+\.csv$/);
    expect(output).toBe("output");
    expect(agentName).toBe("default");
    // Extract UUID part (strip extension)
    const uuidPart = filename.replace(/\.[^.]+$/, "");
    expect(UUID_RE.test(uuidPart)).toBe(true);
  });

  it("creates the output directory", async () => {
    const result = await svc.outputPath("test.txt");
    const dir = result.replace(/\/[^/]+$/, "");
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
    // dir should end with /output (no extra nesting)
    expect(dir).toMatch(/\/output$/);
  });

  it("uses explicit sessionId inside runWithSession", async () => {
    await withSession("test-session", async () => {
      const result = await svc.outputPath("file.json");
      expect(result).toContain("/test-session/default/output/");
      expect(result).toMatch(/\/[0-9a-f-]+\.json$/);
    });
  });

  it("uses fallback UUID outside any session", async () => {
    const result = await svc.outputPath("file.json");
    const parts = result.split("/");
    const fallbackIdx = parts.indexOf("default") - 1;
    expect(UUID_RE.test(parts[fallbackIdx])).toBe(true);
  });

  it("isolates concurrent sessions in outputPath", async () => {
    const paths: Record<string, string> = {};

    await Promise.all([
      withSession("sess-A", async () => {
        paths.a = await svc.outputPath("a.txt");
      }),
      withSession("sess-B", async () => {
        paths.b = await svc.outputPath("b.txt");
      }),
    ]);

    expect(paths.a).toContain("/sess-A/");
    expect(paths.b).toContain("/sess-B/");
  });
});

// --------------- toSessionPath ---------------

describe("toSessionPath", () => {
  let tmp: string;
  let restoreFiles: () => void;
  let svc: ReturnType<typeof createSessionService>;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "session-path-test-"));
    const customFiles = createBunFileService(
      [...config.sandbox.allowedReadPaths, tmp],
      [...config.sandbox.allowedWritePaths, tmp],
    );
    restoreFiles = _setFilesForTest(customFiles);
    svc = createSessionService(customFiles, tmp);
  });

  afterAll(async () => {
    restoreFiles();
    await rm(tmp, { recursive: true, force: true });
  });

  it("strips session dir prefix from absolute path", async () => {
    await withSession("sess-rel", async () => {
      const abs = await svc.outputPath("photo.png");
      const rel = svc.toSessionPath(abs);
      expect(rel).toMatch(/^default\/output\/[0-9a-f-]+\.png$/);
      expect(rel).not.toContain("sess-rel");
    });
  });

  it("returns path unchanged if not under session dir", async () => {
    await withSession("sess-rel2", async () => {
      const foreignPath = "/some/other/path/file.txt";
      expect(svc.toSessionPath(foreignPath)).toBe(foreignPath);
    });
  });
});

// --------------- resolveSessionPath ---------------

describe("resolveSessionPath", () => {
  let tmp: string;
  let restoreFiles: () => void;
  let svc: ReturnType<typeof createSessionService>;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "resolve-path-test-"));
    const customFiles = createBunFileService(
      [...config.sandbox.allowedReadPaths, tmp],
      [...config.sandbox.allowedWritePaths, tmp],
    );
    restoreFiles = _setFilesForTest(customFiles);
    svc = createSessionService(customFiles, tmp);
  });

  afterAll(async () => {
    restoreFiles();
    await rm(tmp, { recursive: true, force: true });
  });

  it("resolves relative path to absolute under session dir", async () => {
    await withSession("sess-resolve", async () => {
      const resolved = svc.resolveSessionPath("image/abc-123/photo.png");
      expect(resolved).toContain("/sess-resolve/image/abc-123/photo.png");
    });
  });

  it("returns absolute paths unchanged", async () => {
    await withSession("sess-resolve2", async () => {
      const abs = "/absolute/path/to/file.txt";
      expect(svc.resolveSessionPath(abs)).toBe(abs);
    });
  });

  it("roundtrips with toSessionPath", async () => {
    await withSession("sess-roundtrip", async () => {
      const abs = await svc.outputPath("data.csv");
      const rel = svc.toSessionPath(abs);
      const back = svc.resolveSessionPath(rel);
      expect(back).toBe(abs);
    });
  });
});
