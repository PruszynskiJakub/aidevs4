import type { Document, DocumentMetadata } from "../../types/document.ts";

export function createDocumentService() {
  const docs = new Map<string, Document>();

  return {
    add(doc: Document): string {
      docs.set(doc.uuid, doc);
      return doc.uuid;
    },

    get(uuid: string): Document | undefined {
      return docs.get(uuid);
    },

    list(): Document[] {
      return [...docs.values()];
    },

    remove(uuid: string): boolean {
      return docs.delete(uuid);
    },

    findByMetadata<K extends keyof DocumentMetadata>(
      key: K,
      value: DocumentMetadata[K],
    ): Document[] {
      return this.list().filter((doc) => doc.metadata[key] === value);
    },

    /** Reset state — for testing only. */
    _clear(): void {
      docs.clear();
    },
  };
}

export const documentService = createDocumentService();
