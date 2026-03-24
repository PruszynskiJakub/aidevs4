import { basename, extname } from "path";
import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import type { ContentPart } from "../types/llm.ts";
import { files } from "../services/common/file.ts";
import { llm } from "../services/ai/llm.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { createDocument, documentService } from "../services/common/document-store.ts";
import { getSessionId } from "../utils/session-context.ts";
import { config } from "../config";
import { IMAGE_EXTENSIONS, TEXT_EXTENSIONS, ALL_SUPPORTED_EXTENSIONS, inferMimeType } from "../utils/media-types.ts";

function resolveFilePath(doc: Document): string {
  const source = doc.metadata.source;
  if (!source) throw new Error(`Document "${doc.uuid}" has no source path`);
  return source;
}

async function buildContentPart(doc: Document): Promise<ContentPart> {
  const path = resolveFilePath(doc);
  const ext = extname(path).toLowerCase();

  if (!IMAGE_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file extension "${ext}" for document "${doc.uuid}". Supported: ${ALL_SUPPORTED_EXTENSIONS.join(", ")}`,
    );
  }

  await files.checkFileSize(path, config.limits.maxFileSize);

  if (IMAGE_EXTENSIONS.has(ext)) {
    const buffer = await files.readBinary(path);
    return { type: "image", data: buffer.toString("base64"), mimeType: inferMimeType(path) };
  }

  const content = await files.readText(path);
  return { type: "text", text: `--- FILE: ${basename(path)} ---\n${content}` };
}

async function ask(payload: {
  uuids: string[];
  question: string;
}): Promise<Document> {
  const { uuids, question } = payload;

  if (!Array.isArray(uuids) || uuids.length === 0) {
    throw new Error("uuids must be a non-empty array of document UUIDs");
  }
  if (uuids.length > config.limits.docMaxFiles) {
    throw new Error(`Too many documents: ${uuids.length}. Maximum is ${config.limits.docMaxFiles}.`);
  }
  if (question.trim().length === 0) {
    throw new Error("question must be a non-empty string");
  }
  assertMaxLength(question, "question", 2000);

  const docs = uuids.map((uuid) => {
    const doc = documentService.get(uuid);
    if (!doc) throw new Error(`Document not found: "${uuid}"`);
    return doc;
  });

  const contentParts = await Promise.all(docs.map(buildContentPart));
  contentParts.push({ type: "text", text: question });

  const response = await llm.chatCompletion({
    model: config.models.gemini,
    messages: [{ role: "user", content: contentParts }],
  });

  const answer = response.content ?? "";
  const docDescriptions = docs.map((d) => d.description).join(", ");

  const shortQuestion = question.length > 120 ? question.slice(0, 117) + "..." : question;
  return createDocument(answer, `Answer to "${shortQuestion}" based on ${docs.length} document(s): ${docDescriptions}`, {
    source: docs[0].metadata.source,
    type: "document",
    mimeType: "text/plain",
  }, getSessionId());
}

async function documentProcessor(args: Record<string, unknown>): Promise<Document> {
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
  switch (action) {
    case "ask":
      return ask(payload as { uuids: string[]; question: string });
    default:
      throw new Error(`Unknown document_processor action: ${action}`);
  }
}

export default {
  name: "document_processor",
  handler: documentProcessor,
} satisfies ToolDefinition;
