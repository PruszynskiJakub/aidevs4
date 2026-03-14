import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResponse } from "../types/tool.ts";
import { files } from "../services/file.ts";
import { ensureOutputDir, outputPath } from "../utils/output.ts";
import { FETCH_TIMEOUT, WEB_ALLOWED_HOSTS, WEB_PLACEHOLDER_MAP } from "../config.ts";
import { safeFilename, assertMaxLength } from "../utils/parse.ts";
import { toolOk } from "../utils/tool-response.ts";

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

function resolvePlaceholders(url: string): string {
  return url.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const resolver = WEB_PLACEHOLDER_MAP[name];
    if (!resolver) {
      const available = Object.keys(WEB_PLACEHOLDER_MAP).join(", ");
      throw new Error(`Unknown placeholder "{{${name}}}". Available: ${available}`);
    }
    return resolver();
  });
}

function assertHostAllowed(hostname: string): void {
  const allowed = WEB_ALLOWED_HOSTS.some((entry) => hostname.endsWith(entry));
  if (!allowed) {
    throw new Error(
      `Host "${hostname}" is not on the allowlist. Allowed: ${WEB_ALLOWED_HOSTS.join(", ")}`,
    );
  }
}

async function download(payload: { url: string; filename: string }): Promise<ToolResponse> {
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

  await ensureOutputDir();

  const response = await fetch(resolvedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${payload.filename}`);
  }

  const path = outputPath(payload.filename);
  await files.write(path, response);

  return toolOk(
    { filename: payload.filename, path },
    [`File saved to ${path}. Inspect with bash: head -5 ${path}`],
  );
}

async function web({ action, payload }: { action: string; payload: Record<string, any> }): Promise<unknown> {
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
