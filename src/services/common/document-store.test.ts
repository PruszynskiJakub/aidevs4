import { describe, it, expect, beforeEach } from "bun:test";
import { createDocumentService } from "./document-store.ts";
import { createDocument } from "../../utils/document.ts";

function makeDoc(text: string, type: "document" | "text" | "image" = "document") {
  return createDocument(text, `test: ${text}`, {
    source: null,
    type,
    mime_type: "text/plain",
  });
}

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
