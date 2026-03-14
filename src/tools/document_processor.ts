import { basename, extname } from "path";
import { GoogleGenAI } from "@google/genai";
import type { ToolDefinition, ToolResponse } from "../types/tool.ts";
import { files } from "../services/file.ts";
import { assertMaxLength, checkFileSize } from "../utils/parse.ts";
import { toolOk } from "../utils/tool-response.ts";
import { GEMINI_MODEL, GEMINI_TIMEOUT, DOC_MAX_FILES, MAX_FILE_SIZE } from "../config.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".csv", ".json", ".xml", ".html"]);
const ALL_SUPPORTED = [...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS].sort();

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

interface ContentPart {
  text?: string;
  inlineData?: { data: string; mimeType: string };
}

function validatePath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("File path must be a non-empty string");
  }
  if (path.includes("..")) {
    throw new Error("Path traversal not allowed: '..' is forbidden");
  }
}

function getExtension(path: string): string {
  return extname(path).toLowerCase();
}

async function buildContentParts(paths: string[]): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];

  for (const path of paths) {
    validatePath(path);
    const ext = getExtension(path);

    if (!IMAGE_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) {
      throw new Error(
        `Unsupported file extension "${ext}". Supported: ${ALL_SUPPORTED.join(", ")}`,
      );
    }

    await checkFileSize(path, MAX_FILE_SIZE);

    if (IMAGE_EXTENSIONS.has(ext)) {
      const buffer = await files.readBinary(path);
      const base64 = buffer.toString("base64");
      parts.push({
        inlineData: { data: base64, mimeType: MIME_TYPES[ext] },
      });
    } else {
      const content = await files.readText(path);
      parts.push({
        text: `--- FILE: ${basename(path)} ---\n${content}`,
      });
    }
  }

  return parts;
}

async function ask(payload: {
  paths: string[];
  question: string;
}): Promise<ToolResponse> {
  const { paths, question } = payload;

  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("paths must be a non-empty array of file paths");
  }
  if (paths.length > DOC_MAX_FILES) {
    throw new Error(`Too many files: ${paths.length}. Maximum is ${DOC_MAX_FILES}.`);
  }
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new Error("question must be a non-empty string");
  }
  assertMaxLength(question, "question", 2000);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Set GEMINI_API_KEY env var to use document_processor.");
  }

  const contentParts = await buildContentParts(paths);
  contentParts.push({ text: question });

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts: contentParts }],
    config: {
      abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT),
    },
  });

  const answer = response.text ?? "";

  return toolOk(
    { answer },
    [`Answer based on ${paths.length} document(s). Use document_processor__ask again for follow-up questions.`],
  );
}

async function documentProcessor({
  action,
  payload,
}: {
  action: string;
  payload: Record<string, any>;
}): Promise<unknown> {
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
