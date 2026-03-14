import { describe, it, expect, beforeAll, afterAll, beforeEach, mock, spyOn } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";

// We need to mock @google/genai before importing the tool
const mockGenerateContent = mock(() =>
  Promise.resolve({ text: "Mocked answer from Gemini" }),
);

mock.module("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
}));

// Import after mocking
const { default: documentProcessor } = await import("./document_processor.ts");

const handler = documentProcessor.handler;

const TEST_DIR = join(import.meta.dir, "..", "__test_fixtures_doc_processor__");
const TEXT_FILE = join(TEST_DIR, "sample.md");
const TEXT_FILE_2 = join(TEST_DIR, "notes.txt");
const CSV_FILE = join(TEST_DIR, "data.csv");
const IMAGE_FILE = join(TEST_DIR, "image.png");
const UNSUPPORTED_FILE = join(TEST_DIR, "file.exe");

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TEXT_FILE, "# Hello\nThis is a test document.");
  writeFileSync(TEXT_FILE_2, "Some notes here.");
  writeFileSync(CSV_FILE, "name,value\nalpha,1\nbeta,2");
  // Minimal valid PNG: 1x1 transparent pixel
  const pngBuf = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  );
  writeFileSync(IMAGE_FILE, pngBuf);
  writeFileSync(UNSUPPORTED_FILE, "binary content");

  process.env.GEMINI_API_KEY = "test-gemini-key";
});

afterAll(() => {
  delete process.env.GEMINI_API_KEY;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  mockGenerateContent.mockClear();
  mockGenerateContent.mockImplementation(() =>
    Promise.resolve({ text: "Mocked answer from Gemini" }),
  );
});

describe("document_processor ask — text files", () => {
  it("processes a single text file and returns an answer", async () => {
    const result = (await handler({
      action: "ask",
      payload: { paths: [TEXT_FILE], question: "What is this about?" },
    })) as any;

    expect(result.status).toBe("ok");
    expect(result.data.answer).toBe("Mocked answer from Gemini");
    expect(result.hints[0]).toContain("1 document(s)");

    // Verify Gemini was called with correct content parts
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateContent.mock.calls[0][0] as any;
    expect(callArgs.model).toBe("gemini-2.5-flash");
    const parts = callArgs.contents[0].parts;
    expect(parts).toHaveLength(2); // 1 text file + 1 question
    expect(parts[0].text).toContain("--- FILE: sample.md ---");
    expect(parts[0].text).toContain("# Hello");
    expect(parts[1].text).toBe("What is this about?");
  });

  it("processes multiple text files", async () => {
    const result = (await handler({
      action: "ask",
      payload: {
        paths: [TEXT_FILE, TEXT_FILE_2, CSV_FILE],
        question: "Summarize everything",
      },
    })) as any;

    expect(result.status).toBe("ok");
    expect(result.hints[0]).toContain("3 document(s)");

    const callArgs = mockGenerateContent.mock.calls[0][0] as any;
    const parts = callArgs.contents[0].parts;
    expect(parts).toHaveLength(4); // 3 files + 1 question
    expect(parts[0].text).toContain("sample.md");
    expect(parts[1].text).toContain("notes.txt");
    expect(parts[2].text).toContain("data.csv");
  });
});

describe("document_processor ask — image files", () => {
  it("sends image as base64 inlineData with correct mimeType", async () => {
    const result = (await handler({
      action: "ask",
      payload: { paths: [IMAGE_FILE], question: "Describe this image" },
    })) as any;

    expect(result.status).toBe("ok");

    const callArgs = mockGenerateContent.mock.calls[0][0] as any;
    const parts = callArgs.contents[0].parts;
    expect(parts).toHaveLength(2); // 1 image + 1 question
    expect(parts[0].inlineData).toBeDefined();
    expect(parts[0].inlineData.mimeType).toBe("image/png");
    expect(typeof parts[0].inlineData.data).toBe("string");
    // Verify it's valid base64
    expect(() => Buffer.from(parts[0].inlineData.data, "base64")).not.toThrow();
  });
});

describe("document_processor ask — mixed files", () => {
  it("handles text and image files together", async () => {
    const result = (await handler({
      action: "ask",
      payload: {
        paths: [TEXT_FILE, IMAGE_FILE],
        question: "Cross-reference text and image",
      },
    })) as any;

    expect(result.status).toBe("ok");
    expect(result.hints[0]).toContain("2 document(s)");

    const callArgs = mockGenerateContent.mock.calls[0][0] as any;
    const parts = callArgs.contents[0].parts;
    expect(parts).toHaveLength(3); // 1 text + 1 image + 1 question
    expect(parts[0].text).toContain("sample.md");
    expect(parts[1].inlineData).toBeDefined();
    expect(parts[2].text).toBe("Cross-reference text and image");
  });
});

describe("document_processor ask — validation errors", () => {
  it("rejects unsupported file extension", async () => {
    await expect(
      handler({
        action: "ask",
        payload: { paths: [UNSUPPORTED_FILE], question: "What is this?" },
      }),
    ).rejects.toThrow('Unsupported file extension ".exe"');
  });

  it("error message includes supported extensions", async () => {
    try {
      await handler({
        action: "ask",
        payload: { paths: [UNSUPPORTED_FILE], question: "What is this?" },
      });
    } catch (e: any) {
      expect(e.message).toContain(".md");
      expect(e.message).toContain(".png");
      expect(e.message).toContain(".jpg");
    }
  });

  it("rejects path traversal with '..'", async () => {
    await expect(
      handler({
        action: "ask",
        payload: { paths: ["../../etc/passwd"], question: "Read this" },
      }),
    ).rejects.toThrow("Path traversal not allowed");
  });

  it("rejects more than 10 files", async () => {
    const manyPaths = Array.from({ length: 11 }, (_, i) => `/tmp/file${i}.txt`);
    await expect(
      handler({
        action: "ask",
        payload: { paths: manyPaths, question: "Summarize" },
      }),
    ).rejects.toThrow("Too many files: 11. Maximum is 10");
  });

  it("rejects empty paths array", async () => {
    await expect(
      handler({
        action: "ask",
        payload: { paths: [], question: "Hello" },
      }),
    ).rejects.toThrow("paths must be a non-empty array");
  });

  it("rejects empty question", async () => {
    await expect(
      handler({
        action: "ask",
        payload: { paths: [TEXT_FILE], question: "" },
      }),
    ).rejects.toThrow("question must be a non-empty string");
  });

  it("rejects whitespace-only question", async () => {
    await expect(
      handler({
        action: "ask",
        payload: { paths: [TEXT_FILE], question: "   " },
      }),
    ).rejects.toThrow("question must be a non-empty string");
  });

  it("rejects question exceeding 2000 chars", async () => {
    await expect(
      handler({
        action: "ask",
        payload: { paths: [TEXT_FILE], question: "x".repeat(2001) },
      }),
    ).rejects.toThrow("question exceeds max length of 2000");
  });

  it("rejects non-existent file", async () => {
    await expect(
      handler({
        action: "ask",
        payload: { paths: [join(TEST_DIR, "nonexistent.txt")], question: "Read" },
      }),
    ).rejects.toThrow();
  });
});

describe("document_processor ask — missing API key", () => {
  it("throws actionable error when GEMINI_API_KEY is not set", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      await expect(
        handler({
          action: "ask",
          payload: { paths: [TEXT_FILE], question: "What is this?" },
        }),
      ).rejects.toThrow("Set GEMINI_API_KEY env var");
    } finally {
      process.env.GEMINI_API_KEY = saved;
    }
  });
});

describe("document_processor — unknown action", () => {
  it("throws on unknown action", async () => {
    await expect(
      handler({ action: "summarize", payload: {} }),
    ).rejects.toThrow("Unknown document_processor action: summarize");
  });
});
