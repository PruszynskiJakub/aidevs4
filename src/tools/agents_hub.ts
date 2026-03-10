import type { ToolDefinition } from "../types/tool.ts";
import { files } from "../services/file.ts";
import { buildHubUrl, getApiKey, sanitizeUrl } from "../utils/hub.ts";
import { ensureOutputDir, outputPath } from "../utils/output.ts";
import { HUB_VERIFY_URL } from "../config.ts";

async function download(payload: { url: string }): Promise<{ url: string; path: string }> {
  await ensureOutputDir();

  const fetchUrl = buildHubUrl(payload.url);
  const filename = new URL(fetchUrl).pathname.split("/").pop() || "file";
  const path = outputPath(filename);

  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${sanitizeUrl(fetchUrl)}: ${response.status}`);
  }

  await files.write(path, response);

  return { url: sanitizeUrl(fetchUrl), path };
}

async function verify(payload: { task: string; answer_file: string }): Promise<{ task: string; response: unknown }> {
  const apiKey = getApiKey();

  const content = await files.readText(payload.answer_file);
  const answer = JSON.parse(content);

  const body = { apikey: apiKey, task: payload.task, answer };

  const res = await fetch(HUB_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Verify request failed: ${res.status} ${res.statusText}`);
  }

  const response = await res.json();
  return { task: payload.task, response };
}

async function agentsHub({ action, payload }: { action: string; payload: Record<string, any> }): Promise<unknown> {
  switch (action) {
    case "download":
      return download(payload as { url: string });
    case "verify":
      return verify(payload as { task: string; answer_file: string });
    default:
      throw new Error(`Unknown agents_hub action: ${action}`);
  }
}

export default {
  name: "agents_hub",
  handler: agentsHub,
} satisfies ToolDefinition;
