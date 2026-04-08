import { basename, extname } from "path";
import { z } from "zod";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import type { ContentPart } from "../types/llm.ts";
import { files } from "../infra/file.ts";
import { llm } from "../llm/llm.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { config } from "../config";
import { IMAGE_EXTENSIONS, TEXT_EXTENSIONS, ALL_SUPPORTED_EXTENSIONS, inferMimeType } from "../utils/media-types.ts";


async function buildContentPart(path: string): Promise<ContentPart> {
  const ext = extname(path).toLowerCase();

  if (!IMAGE_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file extension "${ext}" for file "${basename(path)}". Supported: ${ALL_SUPPORTED_EXTENSIONS.join(", ")}`,
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

/** Strip legacy file:// prefix if present. */
function cleanPath(p: string): string {
  if (p.startsWith("file://")) {
    console.warn(`[document_processor] Legacy file:// URI detected, stripping prefix: ${p}`);
    return p.slice(7);
  }
  return p;
}

async function ask(payload: {
  file_paths: string[];
  question: string;
}): Promise<ToolResult> {
  const { file_paths, question } = payload;

  if (!Array.isArray(file_paths) || file_paths.length === 0) {
    throw new Error("file_paths must be a non-empty array of file paths");
  }
  if (file_paths.length > config.limits.docMaxFiles) {
    throw new Error(`Too many files: ${file_paths.length}. Maximum is ${config.limits.docMaxFiles}.`);
  }
  if (question.trim().length === 0) {
    throw new Error("question must be a non-empty string");
  }
  assertMaxLength(question, "question", 2000);

  const resolvedPaths = file_paths.map(cleanPath);
  const contentParts = await Promise.all(resolvedPaths.map(buildContentPart));
  contentParts.push({ type: "text", text: question });

  const response = await llm.chatCompletion({
    model: config.models.gemini,
    messages: [{ role: "user", content: contentParts }],
  });

  const answer = response.content ?? "";
  return text(answer);
}

async function documentProcessor(args: Record<string, unknown>): Promise<ToolResult> {
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
  switch (action) {
    case "ask":
      return ask(payload as { file_paths: string[]; question: string });
    default:
      throw new Error(`Unknown document_processor action: ${action}`);
  }
}

export default {
  name: "document_processor",
  schema: {
    name: "document_processor",
    description: "Analyze documents (text files, images) using AI vision models. Accepts file paths from previous tool results (e.g. web__download). Supports cross-referencing multiple documents to answer questions.",
    actions: {
      ask: {
        description: "Ask a question about one or more documents using AI vision. Supports text (.md, .txt, .csv, .json, .xml, .html) and image (.png, .jpg, .jpeg, .gif, .webp) documents. Pass file paths from previous tool results (e.g. web__download). Returns a text answer synthesized from all provided documents.",
        schema: z.object({
          file_paths: z.array(z.string()).describe("File paths to analyze (max 10). Use paths returned by other tools such as web__download."),
          question: z.string().describe("Question to answer based on the documents. Be specific about what information you need."),
        }),
      },
    },
  },
  handler: documentProcessor,
} satisfies ToolDefinition;
