import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { files } from "../services/common/file.ts";
import { sessionService } from "../services/agent/session.ts";
import { config } from "../config";
import { safeFilename, assertMaxLength } from "../utils/parse.ts";
import { createDocument } from "../services/common/document-store.ts";
import { getSessionId } from "../utils/session-context.ts";
import { inferCategory, inferMimeType } from "../utils/media-types.ts";

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

async function web(args: Record<string, unknown>): Promise<Document> {
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
  switch (action) {
    case "download":
      return download(payload as { url: string; filename: string });
    default:
      throw new Error(`Unknown web action: ${action}`);
  }
}

export default {
  name: "web",
  handler: web,
} satisfies ToolDefinition;
