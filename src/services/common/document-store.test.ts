import { describe, it, expect, beforeEach } from "bun:test";
import {
  createDocumentService,
  createDocument,
  createErrorDocument,
  formatDocumentXml,
  formatDocumentsXml,
} from "./document-store.ts";
import type { MediaCategory } from "../../utils/media-types.ts";

function makeDoc(text: string, type: MediaCategory = "document") {
  return createDocument(text, `test: ${text}`, {
    source: null,
    type,
    mimeType: "text/plain",
  });
}

describe("createDocument", () => {
  it("generates uuid, computes tokens, and sets sessionUuid", () => {
    const doc = createDocument("hello world", "greeting", {
      source: null,
      type: "document",
      mimeType: "text/plain",
    });

    expect(doc.uuid).toBeTruthy();
    expect(doc.uuid.length).toBe(36); // UUID v4 format
    expect(doc.text).toBe("hello world");
    expect(doc.description).toBe("greeting");
    expect(doc.metadata.source).toBeNull();
    expect(doc.metadata.type).toBe("document");
    expect(doc.metadata.mimeType).toBe("text/plain");
    expect(doc.metadata.tokens).toBe(Math.ceil("hello world".length / 4));
    expect(doc.metadata.sessionUuid).toBe("unknown");
  });

  it("uses explicit sessionId when provided", () => {
    const doc = createDocument("text", "desc", {
      source: null,
      type: "document",
      mimeType: "text/plain",
    }, "my-session-123");

    expect(doc.metadata.sessionUuid).toBe("my-session-123");
  });

  it("preserves source when provided", () => {
    const doc = createDocument("content", "desc", {
      source: "https://example.com",
      type: "image",
      mimeType: "image/png",
    });

    expect(doc.metadata.source).toBe("https://example.com");
    expect(doc.metadata.type).toBe("image");
    expect(doc.metadata.mimeType).toBe("image/png");
  });

  it("estimates tokens as ceil(length/4)", () => {
    const text = "a".repeat(400);
    const doc = createDocument(text, "test", {
      source: null,
      type: "document",
      mimeType: "text/plain",
    });
    expect(doc.metadata.tokens).toBe(100);
  });

  it("handles empty text", () => {
    const doc = createDocument("", "empty", {
      source: null,
      type: "document",
      mimeType: "text/plain",
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
    expect(doc.metadata.mimeType).toBe("text/plain");
    expect(doc.metadata.source).toBeNull();
  });
});

describe("formatDocumentXml", () => {
  it("renders single document as XML tag", () => {
    const doc = createDocument("hello", "greeting", {
      source: null,
      type: "document",
      mimeType: "text/plain",
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
      mimeType: "text/plain",
    });
    const xml = formatDocumentsXml(doc);
    expect(xml).toContain("single");
    expect(xml).toContain("<document");
  });

  it("joins multiple documents with newline", () => {
    const docs = [
      createDocument("first", "doc1", { source: null, type: "document", mimeType: "text/plain" }),
      createDocument("second", "doc2", { source: null, type: "document", mimeType: "text/plain" }),
    ];
    const xml = formatDocumentsXml(docs);
    const lines = xml.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });
});

describe("documentService", () => {
  let service: ReturnType<typeof createDocumentService>;

  beforeEach(() => {
    service = createDocumentService();
  });

  it("add() stores and get() retrieves by uuid", () => {
    const doc = makeDoc("hello");
    const uuid = service.add(doc);
    expect(uuid).toBe(doc.uuid);
    expect(service.get(uuid)).toBe(doc);
  });

  it("get() returns undefined for unknown uuid", () => {
    expect(service.get("nonexistent")).toBeUndefined();
  });

  it("list() returns all documents", () => {
    service.add(makeDoc("a"));
    service.add(makeDoc("b"));
    service.add(makeDoc("c"));
    expect(service.list()).toHaveLength(3);
  });

  it("remove() deletes a document", () => {
    const doc = makeDoc("to-delete");
    service.add(doc);
    expect(service.remove(doc.uuid)).toBe(true);
    expect(service.get(doc.uuid)).toBeUndefined();
  });

  it("remove() returns false for unknown uuid", () => {
    expect(service.remove("nonexistent")).toBe(false);
  });

  it("findByMetadata() filters by type", () => {
    service.add(makeDoc("text-doc", "document"));
    service.add(makeDoc("image-ref", "image"));
    service.add(makeDoc("another-doc", "document"));

    const images = service.findByMetadata("type", "image");
    expect(images).toHaveLength(1);
    expect(images[0].text).toBe("image-ref");

    const docs = service.findByMetadata("type", "document");
    expect(docs).toHaveLength(2);
  });

  it("findByMetadata() returns empty array when no match", () => {
    service.add(makeDoc("doc"));
    expect(service.findByMetadata("type", "image")).toHaveLength(0);
  });
});
