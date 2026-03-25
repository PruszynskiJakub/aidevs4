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

mock.module("../llm/llm.ts", () => ({
  llm: {
    chatCompletion: mockChatCompletion,
    completion: mock(() => Promise.resolve("")),
  },
}));

// Import after mocking
const { default: documentProcessor } = await import("./document_processor.ts");
const { documentService } = await import("../infra/document.ts");

const handler = documentProcessor.handler;

const TEST_DIR = join(import.meta.dir, "..", "__test_fixtures_doc_processor__");
const TEXT_FILE = join(TEST_DIR, "sample.md");
const TEXT_FILE_2 = join(TEST_DIR, "notes.txt");
const CSV_FILE = join(TEST_DIR, "data.csv");
const IMAGE_FILE = join(TEST_DIR, "image.png");
const UNSUPPORTED_FILE = join(TEST_DIR, "file.exe");

/** Helper: create a Document and add it to the store, returning the UUID. */
function addDoc(overrides: Partial<Document> & { metadata: Document["metadata"] }): string {
  const doc: Document = {
    uuid: crypto.randomUUID(),
    text: "",
    description: "test doc",
    ...overrides,
  };
  documentService.add(doc);
  return doc.uuid;
}

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
  documentService._clear();
});

describe("document_processor ask — text files", () => {
  it("processes a single text document and returns a Document", async () => {
    const uuid = addDoc({
      metadata: { source: TEXT_FILE, sessionUuid: "s1", tokens: 10, type: "text", mimeType: "text/plain" },
    });

    const result = await handler({
      action: "ask",
      payload: { uuids: [uuid], question: "What is this about?" },
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

  it("processes multiple text documents", async () => {
    const uuid1 = addDoc({
      metadata: { source: TEXT_FILE, sessionUuid: "s1", tokens: 10, type: "text", mimeType: "text/plain" },
    });
    const uuid2 = addDoc({
      metadata: { source: TEXT_FILE_2, sessionUuid: "s1", tokens: 5, type: "text", mimeType: "text/plain" },
    });
    const uuid3 = addDoc({
      metadata: { source: CSV_FILE, sessionUuid: "s1", tokens: 8, type: "text", mimeType: "text/plain" },
    });

    const result = await handler({
      action: "ask",
      payload: {
        uuids: [uuid1, uuid2, uuid3],
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
    const uuid = addDoc({
      metadata: { source: IMAGE_FILE, sessionUuid: "s1", tokens: 0, type: "image", mimeType: "image/png" },
    });

    const result = await handler({
      action: "ask",
      payload: { uuids: [uuid], question: "Describe this image" },
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
  it("handles text and image documents together", async () => {
    const uuid1 = addDoc({
      metadata: { source: TEXT_FILE, sessionUuid: "s1", tokens: 10, type: "text", mimeType: "text/plain" },
    });
    const uuid2 = addDoc({
      metadata: { source: IMAGE_FILE, sessionUuid: "s1", tokens: 0, type: "image", mimeType: "image/png" },
    });

    const result = await handler({
      action: "ask",
      payload: {
        uuids: [uuid1, uuid2],
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
    const uuid = addDoc({
      metadata: { source: UNSUPPORTED_FILE, sessionUuid: "s1", tokens: 0, type: "document", mimeType: "application/octet-stream" },
    });

    await expect(
      handler({
        action: "ask",
        payload: { uuids: [uuid], question: "What is this?" },
      }),
    ).rejects.toThrow('Unsupported file extension ".exe"');
  });

  it("error message includes supported extensions", async () => {
    const uuid = addDoc({
      metadata: { source: UNSUPPORTED_FILE, sessionUuid: "s1", tokens: 0, type: "document", mimeType: "application/octet-stream" },
    });

    try {
      await handler({
        action: "ask",
        payload: { uuids: [uuid], question: "What is this?" },
      });
    } catch (e: any) {
      expect(e.message).toContain(".md");
      expect(e.message).toContain(".png");
      expect(e.message).toContain(".jpg");
    }
  });

  it("rejects unknown UUID", async () => {
    await expect(
      handler({
        action: "ask",
        payload: { uuids: ["nonexistent-uuid"], question: "Read" },
      }),
    ).rejects.toThrow('Document not found: "nonexistent-uuid"');
  });

  it("rejects document with no source", async () => {
    const uuid = addDoc({
      metadata: { source: null, sessionUuid: "s1", tokens: 0, type: "text", mimeType: "text/plain" },
    });

    await expect(
      handler({
        action: "ask",
        payload: { uuids: [uuid], question: "Read" },
      }),
    ).rejects.toThrow("has no source path");
  });

  it("rejects more than 10 documents", async () => {
    const uuids = Array.from({ length: 11 }, () =>
      addDoc({ metadata: { source: TEXT_FILE, sessionUuid: "s1", tokens: 0, type: "text", mimeType: "text/plain" } }),
    );
    await expect(
      handler({
        action: "ask",
        payload: { uuids, question: "Summarize" },
      }),
    ).rejects.toThrow("Too many documents: 11. Maximum is 10");
  });

  it("rejects empty uuids array", async () => {
    await expect(
      handler({
        action: "ask",
        payload: { uuids: [], question: "Hello" },
      }),
    ).rejects.toThrow("uuids must be a non-empty array");
  });

  it("rejects empty question", async () => {
    const uuid = addDoc({
      metadata: { source: TEXT_FILE, sessionUuid: "s1", tokens: 0, type: "text", mimeType: "text/plain" },
    });

    await expect(
      handler({
        action: "ask",
        payload: { uuids: [uuid], question: "" },
      }),
    ).rejects.toThrow("question must be a non-empty string");
  });

  it("rejects whitespace-only question", async () => {
    const uuid = addDoc({
      metadata: { source: TEXT_FILE, sessionUuid: "s1", tokens: 0, type: "text", mimeType: "text/plain" },
    });

    await expect(
      handler({
        action: "ask",
        payload: { uuids: [uuid], question: "   " },
      }),
    ).rejects.toThrow("question must be a non-empty string");
  });

  it("rejects question exceeding 2000 chars", async () => {
    const uuid = addDoc({
      metadata: { source: TEXT_FILE, sessionUuid: "s1", tokens: 0, type: "text", mimeType: "text/plain" },
    });

    await expect(
      handler({
        action: "ask",
        payload: { uuids: [uuid], question: "x".repeat(2001) },
      }),
    ).rejects.toThrow("question exceeds max length of 2000");
  });
});

describe("document_processor — unknown action", () => {
  it("throws on unknown action", async () => {
    await expect(
      handler({ action: "summarize", payload: {} }),
    ).rejects.toThrow("Unknown document_processor action: summarize");
  });
});
