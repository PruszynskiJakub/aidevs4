import type { Document, DocumentMetadata } from "../types/document.ts";
import { getSessionId } from "../services/agent/session-context.ts";
import { escapeXml } from "./xml.ts";

type CreateDocumentMeta = Pick<DocumentMetadata, "source" | "type" | "mimeType">;

export function createDocument(
  text: string,
  description: string,
  meta: CreateDocumentMeta,
): Document {
  return {
    uuid: crypto.randomUUID(),
    text,
    description,
    metadata: {
      source: meta.source,
      sessionUuid: getSessionId() ?? "unknown",
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
