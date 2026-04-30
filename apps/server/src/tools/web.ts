import { z } from "zod";
import type { ToolDefinition, ToolCallContext } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text, resource } from "../types/tool-result.ts";
import { sandbox as defaultFiles } from "../infra/sandbox.ts";
import { sessionService } from "../agent/session.ts";
import { config } from "../config";
import { safeFilename, assertMaxLength } from "../utils/parse.ts";
import { resolveHubPlaceholders } from "../utils/hub-fetch.ts";
import { inferCategory, inferMimeType } from "../utils/media-types.ts";
import { condense } from "../infra/condense.ts";
import { scrapeUrl } from "../infra/serper.ts";
import { DomainError } from "../types/errors.ts";

const MAX_URL_LENGTH = 2048;

function assertHostAllowed(hostname: string): void {
  const allowed = config.sandbox.webAllowedHosts.some((entry) => hostname.endsWith(entry));
  if (!allowed) {
    throw new DomainError({
      type: "permission",
      message: `Host "${hostname}" is not on the allowlist. Allowed: ${config.sandbox.webAllowedHosts.join(", ")}`,
    });
  }
}

async function download(payload: { url: string; filename: string }): Promise<ToolResult> {
  assertMaxLength(payload.url, "url", 2048);
  assertMaxLength(payload.filename, "filename", 255);
  safeFilename(payload.filename);

  const resolvedUrl = resolveHubPlaceholders(payload.url, config.hub.apiKey);

  let parsed: URL;
  try {
    parsed = new URL(resolvedUrl);
  } catch (err) {
    throw new DomainError({ type: "validation", message: "Invalid URL format", cause: err });
  }

  assertHostAllowed(parsed.hostname);

  const response = await fetch(resolvedUrl, { signal: AbortSignal.timeout(config.limits.fetchTimeout) });
  if (!response.ok) {
    throw new DomainError({
      type: "provider",
      message: `Download failed (${response.status}): ${payload.filename}`,
    });
  }

  const path = await sessionService.outputPath(payload.filename);
  await defaultFiles.write(path, response);

  const contentTypeHeader = response.headers.get("content-type");
  const mimeType = contentTypeHeader || inferMimeType(payload.filename);

  return {
    content: [
      resource(path, `Downloaded: ${payload.filename}`, mimeType),
      { type: "text", text: `File saved to ${path}\nNote: Verify contents or process the file further.` },
    ],
  };
}

function validateUrl(url: string): void {
  assertMaxLength(url, "url", MAX_URL_LENGTH);
  try {
    new URL(url);
  } catch (err) {
    throw new DomainError({ type: "validation", message: `Invalid URL format: ${url.slice(0, 80)}`, cause: err });
  }
}

async function scrapeSingle(url: string): Promise<{ summary: string; fullPath: string | null }> {
  const result = await scrapeUrl(url);

  const { text: summaryText, fullPath } = await condense({
    content: result.text,
    intent: `Web scrape of ${url}`,
    filename: `scrape-${new URL(url).hostname}.txt`,
  });

  return { summary: summaryText, fullPath };
}

async function scrape(payload: { urls: string[] }): Promise<ToolResult> {
  const { urls } = payload;

  if (!Array.isArray(urls) || urls.length === 0) {
    throw new DomainError({ type: "validation", message: "urls must be a non-empty array" });
  }
  if (urls.length > config.limits.maxBatchRows) {
    throw new DomainError({ type: "capacity", message: `Too many URLs (${urls.length}). Maximum: ${config.limits.maxBatchRows}` });
  }

  // Validate all URLs upfront before making any requests
  for (const url of urls) {
    if (typeof url !== "string") throw new DomainError({ type: "validation", message: "Each URL must be a string" });
    validateUrl(url);
  }

  const results = await Promise.allSettled(urls.map((url) => scrapeSingle(url)));

  const summaries: string[] = [];
  const resourceRefs: ToolResult["content"] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      summaries.push(`## ${urls[i]}\n${result.value.summary}`);
      if (result.value.fullPath) {
        const sizeKB = Math.ceil((await defaultFiles.stat(result.value.fullPath)).size / 1024);
        resourceRefs.push(resource(result.value.fullPath, `Full content of ${urls[i]} (${sizeKB}KB)`));
      }
    } else {
      const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      summaries.push(`## ${urls[i]}\nError: ${errorMsg}`);
    }
  }

  return {
    content: [
      { type: "text", text: summaries.join("\n\n") },
      ...resourceRefs,
    ],
  };
}

async function web(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<ToolResult> {
  const files = ctx?.runCtx?.files ?? defaultFiles;
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
  switch (action) {
    case "download":
      return download(payload as { url: string; filename: string });
    case "scrape":
      return scrape(payload as { urls: string[] });
    default:
      throw new DomainError({ type: "validation", message: `Unknown web action: ${action}` });
  }
}

export default {
  name: "web",
  confirmIf: undefined,
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
