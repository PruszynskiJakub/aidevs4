import { describe, it, expect } from "bun:test";
import { DocumentStore } from "./document-store.ts";
import { createDocument } from "../../utils/document.ts";

function makeDoc(text: string, type: "document" | "text" | "image" = "document") {
  return createDocument(text, `test: ${text}`, {
    source: null,
    type,
    mime_type: "text/plain",
  });
}

describe("DocumentStore", () => {
  it("add() stores and get() retrieves by uuid", () => {
    const store = new DocumentStore();
    const doc = makeDoc("hello");
    const uuid = store.add(doc);
    expect(uuid).toBe(doc.uuid);
    expect(store.get(uuid)).toBe(doc);
  });

  it("get() returns undefined for unknown uuid", () => {
    const store = new DocumentStore();
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("list() returns all documents", () => {
    const store = new DocumentStore();
    store.add(makeDoc("a"));
    store.add(makeDoc("b"));
    store.add(makeDoc("c"));
    expect(store.list()).toHaveLength(3);
  });

  it("remove() deletes a document", () => {
    const store = new DocumentStore();
    const doc = makeDoc("to-delete");
    store.add(doc);
    expect(store.remove(doc.uuid)).toBe(true);
    expect(store.get(doc.uuid)).toBeUndefined();
  });

  it("remove() returns false for unknown uuid", () => {
    const store = new DocumentStore();
    expect(store.remove("nonexistent")).toBe(false);
  });

  it("findByMetadata() filters by type", () => {
    const store = new DocumentStore();
    store.add(makeDoc("text-doc", "document"));
    store.add(makeDoc("image-ref", "image"));
    store.add(makeDoc("another-doc", "document"));

    const images = store.findByMetadata("type", "image");
    expect(images).toHaveLength(1);
    expect(images[0].text).toBe("image-ref");

    const docs = store.findByMetadata("type", "document");
    expect(docs).toHaveLength(2);
  });

  it("findByMetadata() returns empty array when no match", () => {
    const store = new DocumentStore();
    store.add(makeDoc("doc"));
    expect(store.findByMetadata("type", "image")).toHaveLength(0);
  });
});
