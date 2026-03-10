import type { ToolDefinition } from "../types/tool.ts";
import { files } from "../services/file.ts";
import { getApiKey } from "../utils/hub.ts";
import { ensureOutputDir, outputPath } from "../utils/output.ts";
import { HUB_BASE_URL, HUB_VERIFY_URL } from "../config.ts";

async function download(payload: { filename: string }): Promise<{ filename: string; path: string }> {
  await ensureOutputDir();

  const apiKey = getApiKey();
  const url = `${HUB_BASE_URL}/data/${apiKey}/${payload.filename}`;
  const path = outputPath(payload.filename);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${payload.filename}: ${response.status}`);
  }

  await files.write(path, response);

  return { filename: payload.filename, path };
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
      return download(payload as { filename: string });
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
