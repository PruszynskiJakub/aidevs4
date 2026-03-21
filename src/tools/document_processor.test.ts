import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import type { ChatCompletionParams, LLMChatResponse } from "../types/llm.ts";
import type { Document } from "../types/document.ts";

// Mock llm service before importing the tool
const mockChatCompletion = mock(
  (_params: ChatCompletionParams): Promise<LLMChatResponse> =>
    Promise.resolve({
      content: "Mocked answer from Gemini",
      toolCalls: [],
      finishReason: "stop",
    }),
);

mock.module("../services/ai/llm.ts", () => ({
  llm: {
    chatCompletion: mockChatCompletion,
    completion: mock(() => Promise.resolve("")),
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
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  mockChatCompletion.mockClear();
  mockChatCompletion.mockImplementation(
    () =>
      Promise.resolve({
        content: "Mocked answer from Gemini",
        toolCalls: [],
        finishReason: "stop",
      }),
  );
});

describe("document_processor ask — text files", () => {
  it("processes a single text file and returns a Document", async () => {
    const result = await handler({
      action: "ask",
      payload: { paths: [TEXT_FILE], question: "What is this about?" },
    }) as Document;

    expect(result.text).toBe("Mocked answer from Gemini");
    expect(result.description).toContain("1 document(s)");
    expect(result.metadata.type).toBe("document");
    expect(result.metadata.mimeType).toBe("text/plain");

    // Verify llm.chatCompletion was called with correct params
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    const callArgs = mockChatCompletion.mock.calls[0][0] as ChatCompletionParams;
    expect(callArgs.model).toBe("gemini-3-flash-preview");

    // Content should be ContentPart[]
    const msg = callArgs.messages[0];
    expect(msg.role).toBe("user");
    const content = msg.content as any[];
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2); // 1 text file + 1 question
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("--- FILE: sample.md ---");
    expect(content[0].text).toContain("# Hello");
    expect(content[1].type).toBe("text");
    expect(content[1].text).toBe("What is this about?");
  });

  it("processes multiple text files", async () => {
    const result = await handler({
      action: "ask",
      payload: {
        paths: [TEXT_FILE, TEXT_FILE_2, CSV_FILE],
        question: "Summarize everything",
      },
    }) as Document;

    expect(result.description).toContain("3 document(s)");

    const callArgs = mockChatCompletion.mock.calls[0][0] as ChatCompletionParams;
    const content = callArgs.messages[0].content as any[];
    expect(content).toHaveLength(4); // 3 files + 1 question
    expect(content[0].text).toContain("sample.md");
    expect(content[1].text).toContain("notes.txt");
    expect(content[2].text).toContain("data.csv");
  });
});

describe("document_processor ask — image files", () => {
  it("sends image as base64 ImagePart with correct mimeType", async () => {
    const result = await handler({
      action: "ask",
      payload: { paths: [IMAGE_FILE], question: "Describe this image" },
    }) as Document;

    expect(result.text).toBe("Mocked answer from Gemini");

    const callArgs = mockChatCompletion.mock.calls[0][0] as ChatCompletionParams;
    const content = callArgs.messages[0].content as any[];
    expect(content).toHaveLength(2); // 1 image + 1 question
    expect(content[0].type).toBe("image");
    expect(content[0].mimeType).toBe("image/png");
    expect(typeof content[0].data).toBe("string");
    // Verify it's valid base64
    expect(() => Buffer.from(content[0].data, "base64")).not.toThrow();
  });
});

describe("document_processor ask — mixed files", () => {
  it("handles text and image files together", async () => {
    const result = await handler({
      action: "ask",
      payload: {
        paths: [TEXT_FILE, IMAGE_FILE],
        question: "Cross-reference text and image",
      },
    }) as Document;

    expect(result.description).toContain("2 document(s)");

    const callArgs = mockChatCompletion.mock.calls[0][0] as ChatCompletionParams;
    const content = callArgs.messages[0].content as any[];
    expect(content).toHaveLength(3); // 1 text + 1 image + 1 question
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("sample.md");
    expect(content[1].type).toBe("image");
    expect(content[2].type).toBe("text");
    expect(content[2].text).toBe("Cross-reference text and image");
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

describe("document_processor — unknown action", () => {
  it("throws on unknown action", async () => {
    await expect(
      handler({ action: "summarize", payload: {} }),
    ).rejects.toThrow("Unknown document_processor action: summarize");
  });
});
