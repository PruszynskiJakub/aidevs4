import { describe, it, expect } from "bun:test";
import { createDocument, createErrorDocument, formatDocumentXml, formatDocumentsXml } from "./document.ts";

describe("createDocument", () => {
  it("generates uuid, computes tokens, and sets sessionUuid", () => {
    const doc = createDocument("hello world", "greeting", {
      source: null,
      type: "document",
      mime_type: "text/plain",
    });

    expect(doc.uuid).toBeTruthy();
    expect(doc.uuid.length).toBe(36); // UUID v4 format
    expect(doc.text).toBe("hello world");
    expect(doc.description).toBe("greeting");
    expect(doc.metadata.source).toBeNull();
    expect(doc.metadata.type).toBe("document");
    expect(doc.metadata.mime_type).toBe("text/plain");
    expect(doc.metadata.tokens).toBe(Math.ceil("hello world".length / 4));
    expect(doc.metadata.sessionUuid).toBeTruthy();
  });

  it("preserves source when provided", () => {
    const doc = createDocument("content", "desc", {
      source: "https://example.com",
      type: "image",
      mime_type: "image/png",
    });

    expect(doc.metadata.source).toBe("https://example.com");
    expect(doc.metadata.type).toBe("image");
    expect(doc.metadata.mime_type).toBe("image/png");
  });

  it("estimates tokens as ceil(length/4)", () => {
    const text = "a".repeat(400);
    const doc = createDocument(text, "test", {
      source: null,
      type: "document",
      mime_type: "text/plain",
    });
    expect(doc.metadata.tokens).toBe(100);
  });

  it("handles empty text", () => {
    const doc = createDocument("", "empty", {
      source: null,
      type: "document",
      mime_type: "text/plain",
    });
    expect(doc.metadata.tokens).toBe(0);
    expect(doc.text).toBe("");
  });
});

describe("createErrorDocument", () => {
  it("creates document with Error: prefix", () => {
    const doc = createErrorDocument("bash", "command not found");
    expect(doc.text).toBe("Error: command not found");
    expect(doc.description).toBe("Error from bash");
    expect(doc.metadata.type).toBe("document");
    expect(doc.metadata.mime_type).toBe("text/plain");
    expect(doc.metadata.source).toBeNull();
  });
});

describe("formatDocumentXml", () => {
  it("renders single document as XML tag", () => {
    const doc = createDocument("hello", "greeting", {
      source: null,
      type: "document",
      mime_type: "text/plain",
    });
    const xml = formatDocumentXml(doc);
    expect(xml).toBe(`<document id="${doc.uuid}" description="greeting">hello</document>`);
  });
});

describe("formatDocumentsXml", () => {
  it("handles single document (not array)", () => {
    const doc = createDocument("single", "test", {
      source: null,
      type: "document",
      mime_type: "text/plain",
    });
    const xml = formatDocumentsXml(doc);
    expect(xml).toContain("single");
    expect(xml).toContain("<document");
  });

  it("joins multiple documents with newline", () => {
    const docs = [
      createDocument("first", "doc1", { source: null, type: "document", mime_type: "text/plain" }),
      createDocument("second", "doc2", { source: null, type: "document", mime_type: "text/plain" }),
    ];
    const xml = formatDocumentsXml(docs);
    const lines = xml.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });
});
