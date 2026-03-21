import type { Document, DocumentMetadata } from "../../types/document.ts";
import { escapeXml } from "../../utils/xml.ts";

// ── Document factory functions ──────────────────────────────────

type CreateDocumentMeta = Pick<DocumentMetadata, "source" | "type" | "mimeType">;

export function createDocument(
  text: string,
  description: string,
  meta: CreateDocumentMeta,
  sessionId: string = "unknown",
): Document {
  return {
    uuid: crypto.randomUUID(),
    text,
    description,
    metadata: {
      source: meta.source,
      sessionUuid: sessionId,
      tokens: Math.ceil(text.length / 4),
      type: meta.type,
      mimeType: meta.mimeType,
    },
  };
}

export function createErrorDocument(toolName: string, message: string): Document {
  return createDocument(
    `Error: ${message}`,
    `Error from ${toolName}`,
    { source: null, type: "document", mimeType: "text/plain" },
  );
}

export function formatDocumentXml(doc: Document): string {
  return `<document id="${doc.uuid}" description="${escapeXml(doc.description)}">${doc.text}</document>`;
}

export function formatDocumentsXml(docs: Document | Document[]): string {
  const arr = Array.isArray(docs) ? docs : [docs];
  return arr.map(formatDocumentXml).join("\n");
}

// ── Document store service ──────────────────────────────────────

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