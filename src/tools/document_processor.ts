import { basename, extname } from "path";
import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import type { ContentPart } from "../types/llm.ts";
import { files } from "../services/common/file.ts";
import { llm } from "../services/ai/llm.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { createDocument } from "../services/common/document-store.ts";
import { sessionService } from "../services/agent/session.ts";
import { getSessionId } from "../utils/session-context.ts";
import { config } from "../config";
import { IMAGE_EXTENSIONS, TEXT_EXTENSIONS, ALL_SUPPORTED_EXTENSIONS, inferMimeType } from "../utils/media-types.ts";

function validatePath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("File path must be a non-empty string");
  }
  if (path.includes("..")) {
    throw new Error("Path traversal not allowed: '..' is forbidden");
  }
}

async function buildContentParts(paths: string[]): Promise<ContentPart[]> {
  // Validate all paths synchronously before any I/O
  const resolved = paths.map((rawPath) => {
    validatePath(rawPath);
    const path = sessionService.resolveSessionPath(rawPath);
    const ext = extname(path).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) {
      throw new Error(
        `Unsupported file extension "${ext}". Supported: ${ALL_SUPPORTED_EXTENSIONS.join(", ")}`,
      );
    }
    return { path, ext };
  });

  // Read all files concurrently
  return Promise.all(
    resolved.map(async ({ path, ext }): Promise<ContentPart> => {
      await files.checkFileSize(path, config.limits.maxFileSize);
      if (IMAGE_EXTENSIONS.has(ext)) {
        const buffer = await files.readBinary(path);
        return { type: "image", data: buffer.toString("base64"), mimeType: inferMimeType(path) };
      }
      const content = await files.readText(path);
      return { type: "text", text: `--- FILE: ${basename(path)} ---\n${content}` };
    }),
  );
}

async function ask(payload: {
  paths: string[];
  question: string;
}): Promise<Document> {
  const { paths, question } = payload;

  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("paths must be a non-empty array of file paths");
  }
  if (paths.length > config.limits.docMaxFiles) {
    throw new Error(`Too many files: ${paths.length}. Maximum is ${config.limits.docMaxFiles}.`);
  }
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new Error("question must be a non-empty string");
  }
  assertMaxLength(question, "question", 2000);

  const contentParts = await buildContentParts(paths);
  contentParts.push({ type: "text", text: question });

  const response = await llm.chatCompletion({
    model: config.models.gemini,
    messages: [{ role: "user", content: contentParts }],
  });

  const answer = response.content ?? "";
  const fileNames = paths.map((p) => basename(p)).join(", ");

  return createDocument(answer, `Answer based on ${paths.length} document(s): ${fileNames}`, {
    source: paths[0],
    type: "document",
    mimeType: "text/plain",
  }, getSessionId());
}

async function documentProcessor(args: Record<string, unknown>): Promise<Document> {
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
  switch (action) {
    case "ask":
      return ask(payload as { paths: string[]; question: string });
    default:
      throw new Error(`Unknown document_processor action: ${action}`);
  }
}

export default {
  name: "document_processor",
  handler: documentProcessor,
} satisfies ToolDefinition;
