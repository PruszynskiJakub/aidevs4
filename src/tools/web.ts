import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { files } from "../services/common/file.ts";
import { sessionService } from "../services/agent/session.ts";
import { config } from "../config";
import { safeFilename, assertMaxLength } from "../utils/parse.ts";
import { createDocument } from "../services/common/document-store.ts";
import { getSessionId } from "../utils/session-context.ts";
import { inferCategory, inferMimeType } from "../utils/media-types.ts";

const SERPER_SCRAPE_URL = "https://scrape.serper.dev";
const MAX_URL_LENGTH = 2048;

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

const placeholderMap: Record<string, () => string> = {
  hub_api_key: () => config.hub.apiKey,
};

function resolvePlaceholders(url: string): string {
  return url.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const resolver = placeholderMap[name];
    if (!resolver) {
      const available = Object.keys(placeholderMap).join(", ");
      throw new Error(`Unknown placeholder "{{${name}}}". Available: ${available}`);
    }
    return resolver();
  });
}

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

  const resolvedUrl = resolvePlaceholders(payload.url);

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
  const apiKey = config.keys.serperApiKey;
  if (!apiKey) {
    throw new Error("SERPER_API_KEY is not configured");
  }

  const response = await fetch(SERPER_SCRAPE_URL, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(config.limits.fetchTimeout),
  });

  if (!response.ok) {
    throw new Error(`Scrape failed (${response.status}) for ${url.slice(0, 80)}`);
  }

  const data = await response.json();
  const text = data.text ?? data.content ?? data.markdown ?? JSON.stringify(data);

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
  handler: web,
} satisfies ToolDefinition;
