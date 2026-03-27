import { z } from "zod";
import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { files } from "../infra/file.ts";
import { sessionService } from "../agent/session.ts";
import { config } from "../config";
import { safeFilename, assertMaxLength } from "../utils/parse.ts";
import { createDocument } from "../infra/document.ts";
import { getSessionId } from "../agent/context.ts";
import { inferCategory, inferMimeType } from "../utils/media-types.ts";
import { condense } from "../infra/condense.ts";
import { scrapeUrl } from "../infra/serper.ts";

const MAX_URL_LENGTH = 2048;

function assertHostAllowed(hostname: string): void {
  const allowed = config.sandbox.webAllowedHosts.some((entry) => hostname.endsWith(entry));
  if (!allowed) {
    throw new Error(
      `Host "${hostname}" is not on the allowlist. Allowed: ${config.sandbox.webAllowedHosts.join(", ")}`,
    );
  }
}

async function download(payload: { url: string; filename: string }): Promise<Document> {
  assertMaxLength(payload.url, "url", 2048);
  assertMaxLength(payload.filename, "filename", 255);
  safeFilename(payload.filename);

  const resolvedUrl = payload.url.replace("{{hub_api_key}}", config.hub.apiKey);

  let parsed: URL;
  try {
    parsed = new URL(resolvedUrl);
  } catch {
    throw new Error("Invalid URL format");
  }

  assertHostAllowed(parsed.hostname);

  const response = await fetch(resolvedUrl, { signal: AbortSignal.timeout(config.limits.fetchTimeout) });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${payload.filename}`);
  }

  const path = await sessionService.outputPath(payload.filename);
  await files.write(path, response);

  const contentTypeHeader = response.headers.get("content-type");
  const type = inferCategory(payload.filename);
  const mimeType = contentTypeHeader || inferMimeType(payload.filename);

  // Use session-relative path to save tokens in LLM context.
  // bash cwd is already the session output dir, so relative paths work directly.
  const relativePath = sessionService.toSessionPath(path);
  const text = `File saved to ${relativePath}.\nNote: Verify contents or process the file further.`;

  return createDocument(text, `Web download from ${payload.url}`, {
    source: path,
    type,
    mimeType,
  }, getSessionId());
}

function validateUrl(url: string): void {
  assertMaxLength(url, "url", MAX_URL_LENGTH);
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL format: ${url.slice(0, 80)}`);
  }
}

async function scrapeSingle(url: string): Promise<Document> {
  const result = await scrapeUrl(url);

  const { text } = await condense({
    content: result.text,
    intent: `Web scrape of ${url}`,
    filename: `scrape-${new URL(url).hostname}.txt`,
  });

  return createDocument(
    text,
    `Scraped content from ${url}`,
    { source: url, type: "text" as const, mimeType: "text/plain" },
    getSessionId(),
  );
}

async function scrape(payload: { urls: string[] }): Promise<Document[]> {
  const { urls } = payload;

  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("urls must be a non-empty array");
  }
  if (urls.length > config.limits.maxBatchRows) {
    throw new Error(`Too many URLs (${urls.length}). Maximum: ${config.limits.maxBatchRows}`);
  }

  // Validate all URLs upfront before making any requests
  for (const url of urls) {
    if (typeof url !== "string") throw new Error("Each URL must be a string");
    validateUrl(url);
  }

  const results = await Promise.allSettled(urls.map((url) => scrapeSingle(url)));

  return results.map((result, i) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return createDocument(
      `Error scraping ${urls[i]}: ${errorMsg}`,
      `Scrape error for ${urls[i]}`,
      { source: urls[i], type: "text" as const, mimeType: "text/plain" },
      getSessionId(),
    );
  });
}

async function web(args: Record<string, unknown>): Promise<Document | Document[]> {
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
  switch (action) {
    case "download":
      return download(payload as { url: string; filename: string });
    case "scrape":
      return scrape(payload as { urls: string[] });
    default:
      throw new Error(`Unknown web action: ${action}`);
  }
}

export default {
  name: "web",
  schema: {
    name: "web",
    description: "Interact with the web: download data files from allowlisted hosts or scrape readable text from any web page. For HTML pages, prefer scrape — it returns clean text. Use download only for non-HTML files (JSON, CSV, images, ZIP, etc.).",
    actions: {
      download: {
        description: "Download a non-HTML data file (JSON, CSV, images, audio, ZIP, etc.) from an allowlisted URL and save to disk. Do NOT use for HTML web pages — use scrape instead to get readable text. Supports {{placeholder}} template variables (available: hub_api_key). Returns the saved file path and size.",
        schema: z.object({
          url: z.string().describe("Full URL to download from. May contain {{placeholder}} variables (e.g. https://hub.ag3nts.org/data/{{hub_api_key}}/file.txt). Host must be on the allowlist."),
          filename: z.string().describe("Filename to save as in the session output directory (e.g. 'data.json'). No path separators."),
        }),
      },
      scrape: {
        description: "Read web pages by extracting their text content. This is the default choice for any HTML URL — returns clean, readable text without HTML tags. Accepts an array of URLs, scrapes them in parallel. Each URL is independent — one failure won't affect others. Works with any URL (no host restriction).",
        schema: z.object({
          urls: z.array(z.string()).describe("URLs of web pages to scrape (1 or more). Each is fetched independently."),
        }),
      },
    },
  },
  handler: web,
} satisfies ToolDefinition;
