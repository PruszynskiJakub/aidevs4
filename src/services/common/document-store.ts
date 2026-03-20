import type { Document, DocumentMetadata } from "../../types/document.ts";

export class DocumentStore {
  private readonly docs = new Map<string, Document>();

  add(doc: Document): string {
    this.docs.set(doc.uuid, doc);
    return doc.uuid;
  }

  get(uuid: string): Document | undefined {
    return this.docs.get(uuid);
  }

  list(): Document[] {
    return [...this.docs.values()];
  }

  remove(uuid: string): boolean {
    return this.docs.delete(uuid);
  }

  findByMetadata<K extends keyof DocumentMetadata>(
    key: K,
    value: DocumentMetadata[K],
  ): Document[] {
    return this.list().filter((doc) => doc.metadata[key] === value);
  }
}
