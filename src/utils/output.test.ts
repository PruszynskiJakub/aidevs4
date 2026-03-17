import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { inferFileType, outputPath, getEffectiveSessionId } from "./output.ts";
import { _testWritePaths } from "../services/file.ts";
import { runWithSession } from "../services/session-context.ts";

// --------------- inferFileType ---------------

describe("inferFileType", () => {
  it("returns 'image' for image extensions", () => {
    expect(inferFileType("photo.png")).toBe("image");
    expect(inferFileType("photo.jpg")).toBe("image");
    expect(inferFileType("photo.jpeg")).toBe("image");
    expect(inferFileType("photo.gif")).toBe("image");
    expect(inferFileType("photo.webp")).toBe("image");
    expect(inferFileType("photo.svg")).toBe("image");
    expect(inferFileType("photo.bmp")).toBe("image");
    expect(inferFileType("photo.ico")).toBe("image");
  });

  it("returns 'audio' for audio extensions", () => {
    expect(inferFileType("song.mp3")).toBe("audio");
    expect(inferFileType("sound.wav")).toBe("audio");
    expect(inferFileType("track.ogg")).toBe("audio");
    expect(inferFileType("track.flac")).toBe("audio");
    expect(inferFileType("track.aac")).toBe("audio");
    expect(inferFileType("track.m4a")).toBe("audio");
  });

  it("returns 'video' for video extensions", () => {
    expect(inferFileType("clip.mp4")).toBe("video");
    expect(inferFileType("clip.avi")).toBe("video");
    expect(inferFileType("clip.mov")).toBe("video");
    expect(inferFileType("clip.mkv")).toBe("video");
    expect(inferFileType("clip.webm")).toBe("video");
  });

  it("returns 'document' for document extensions", () => {
    expect(inferFileType("report.pdf")).toBe("document");
    expect(inferFileType("data.csv")).toBe("document");
    expect(inferFileType("notes.txt")).toBe("document");
    expect(inferFileType("config.json")).toBe("document");
    expect(inferFileType("page.html")).toBe("document");
  });

  it("returns 'document' for unknown extensions", () => {
    expect(inferFileType("archive.xyz")).toBe("document");
    expect(inferFileType("file.unknown")).toBe("document");
  });

  it("returns 'document' for files with no extension", () => {
    expect(inferFileType("Makefile")).toBe("document");
    expect(inferFileType("README")).toBe("document");
  });

  it("handles case-insensitive extensions", () => {
    expect(inferFileType("photo.PNG")).toBe("image");
    expect(inferFileType("photo.Jpg")).toBe("image");
    expect(inferFileType("song.MP3")).toBe("audio");
    expect(inferFileType("clip.MP4")).toBe("video");
  });
});

// --------------- outputPath ---------------

describe("outputPath", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "output-test-"));
    _testWritePaths.push(tmp);
  });

  afterAll(async () => {
    _testWritePaths.splice(_testWritePaths.indexOf(tmp), 1);
    await rm(tmp, { recursive: true, force: true });
  });

  // UUID v4 pattern: 8-4-4-4-12 hex chars
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("returns path with correct structure: {outputDir}/{sessionId}/{type}/{uuid}/{filename}", async () => {
    const result = await outputPath("report.csv");

    // Path should end with {sessionId}/document/{uuid}/report.csv
    const parts = result.split("/");
    const filename = parts.pop()!;
    const uuid = parts.pop()!;
    const type = parts.pop()!;
    const sessionSegment = parts.pop()!;

    expect(filename).toBe("report.csv");
    expect(type).toBe("document");
    expect(UUID_RE.test(uuid)).toBe(true);
    // sessionSegment is either an explicit session or a fallback UUID
    expect(sessionSegment.length).toBeGreaterThan(0);
  });

  it("creates the UUID directory", async () => {
    const result = await outputPath("test.txt");

    // The directory containing the file should exist
    const dir = result.replace(/\/[^/]+$/, "");
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
  });

  it("categorizes image files correctly in path", async () => {
    const result = await outputPath("photo.png");
    expect(result).toContain("/image/");
  });

  it("categorizes audio files correctly in path", async () => {
    const result = await outputPath("song.mp3");
    expect(result).toContain("/audio/");
  });

  it("categorizes video files correctly in path", async () => {
    const result = await outputPath("clip.mp4");
    expect(result).toContain("/video/");
  });

  it("generates unique UUIDs for each call", async () => {
    const path1 = await outputPath("a.txt");
    const path2 = await outputPath("b.txt");

    const uuid1 = path1.split("/").slice(-2, -1)[0];
    const uuid2 = path2.split("/").slice(-2, -1)[0];

    expect(uuid1).not.toBe(uuid2);
  });

  it("uses explicit sessionId inside runWithSession", async () => {
    await runWithSession("test-session", async () => {
      const result = await outputPath("file.json");
      expect(result).toContain("/test-session/document/");
    });
  });

  it("uses fallback UUID outside any session", async () => {
    // Called outside runWithSession — should use a stable fallback UUID
    const result = await outputPath("file.json");
    const sessionSegment = result.split("/").slice(-4, -3)[0];
    expect(UUID_RE.test(sessionSegment)).toBe(true);

    // Fallback is stable across calls
    const result2 = await outputPath("other.json");
    const sessionSegment2 = result2.split("/").slice(-4, -3)[0];
    expect(sessionSegment2).toBe(sessionSegment);
  });

  it("isolates concurrent sessions in outputPath", async () => {
    const paths: Record<string, string> = {};

    await Promise.all([
      runWithSession("sess-A", async () => {
        paths.a = await outputPath("a.txt");
      }),
      runWithSession("sess-B", async () => {
        paths.b = await outputPath("b.txt");
      }),
    ]);

    expect(paths.a).toContain("/sess-A/");
    expect(paths.b).toContain("/sess-B/");
    expect(paths.a).not.toContain("/sess-B/");
    expect(paths.b).not.toContain("/sess-A/");
  });
});
