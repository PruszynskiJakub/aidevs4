import type { ToolDefinition } from "../types/tool.ts";
import { files } from "../services/file.ts";
import { getApiKey } from "../utils/hub.ts";
import { ensureOutputDir, outputPath } from "../utils/output.ts";
import { HUB_BASE_URL, HUB_VERIFY_URL } from "../config.ts";
import { parseCsv } from "../utils/csv.ts";
import { inspectFile } from "./filesystem.ts";

async function download(payload: { filename: string }): Promise<{ filename: string; path: string; inspection: unknown }> {
  await ensureOutputDir();

  const apiKey = getApiKey();
  const url = `${HUB_BASE_URL}/data/${apiKey}/${payload.filename}`;
  const path = outputPath(payload.filename);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${payload.filename}: ${response.status}`);
  }

  await files.write(path, response);

  let inspection: unknown = null;
  try {
    inspection = await inspectFile(path);
  } catch {
    // Unsupported format or inspection failure — leave as null
  }

  return { filename: payload.filename, path, inspection };
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

  const response = await res.json().catch(() => res.text());

  if (!res.ok) {
    const detail = typeof response === "string" ? response : JSON.stringify(response);
    throw new Error(`Verify failed (${res.status}): ${detail}`);
  }

  return { task: payload.task, response };
}

async function apiRequest(payload: {
  path: string;
  body?: Record<string, any>;
  body_file?: string;
}): Promise<{ path: string; response: unknown }> {
  const hasBody = payload.body !== undefined;
  const hasFile = payload.body_file !== undefined;

  if (hasBody && hasFile) {
    throw new Error("Provide either body or body_file, not both");
  }
  if (!hasBody && !hasFile) {
    throw new Error("Provide either body or body_file");
  }

  let body: Record<string, any>;
  if (hasFile) {
    const content = await files.readText(payload.body_file!);
    body = JSON.parse(content);
  } else {
    body = { ...payload.body };
  }

  const apiKey = getApiKey();
  body.apikey = apiKey;

  const url = `${HUB_BASE_URL}/api/${payload.path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const contentType = res.headers.get("content-type") || "";
  const response = contentType.includes("application/json")
    ? await res.json()
    : await res.text();

  if (!res.ok) {
    const detail = typeof response === "string" ? response : JSON.stringify(response);
    throw new Error(`API request failed (${res.status}): ${detail}`);
  }

  return { path: payload.path, response };
}

async function apiBatch(payload: {
  path: string;
  data_file: string;
  field_map_json: string;
  output_file: string;
}): Promise<{ path: string; count: number; output_file: string }> {
  const fieldMap: Record<string, string> = JSON.parse(payload.field_map_json);

  let rows: Record<string, any>[];
  if (payload.data_file.endsWith(".csv")) {
    rows = await parseCsv(payload.data_file);
  } else {
    const content = await files.readText(payload.data_file);
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      throw new Error("JSON data file must contain an array");
    }
    rows = parsed;
  }

  const apiKey = getApiKey();
  const url = `${HUB_BASE_URL}/api/${payload.path}`;
  const results: { input: Record<string, any>; response: unknown }[] = [];

  for (const row of rows) {
    const mapped: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      const targetKey = fieldMap[key] ?? key;
      mapped[targetKey] = value;
    }
    mapped.apikey = apiKey;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mapped),
    });

    const contentType = res.headers.get("content-type") || "";
    const response = contentType.includes("application/json")
      ? await res.json()
      : await res.text();

    if (!res.ok) {
      results.push({ input: row, response });
      await files.write(payload.output_file, JSON.stringify(results, null, 2));
      const detail = typeof response === "string" ? response : JSON.stringify(response);
      throw new Error(`API batch request failed at row ${results.length} (${res.status}): ${detail}`);
    }

    results.push({ input: row, response });
  }

  await files.write(payload.output_file, JSON.stringify(results, null, 2));

  return { path: payload.path, count: results.length, output_file: payload.output_file };
}

async function agentsHub({ action, payload }: { action: string; payload: Record<string, any> }): Promise<unknown> {
  switch (action) {
    case "download":
      return download(payload as { filename: string });
    case "verify":
      return verify(payload as { task: string; answer_file: string });
    case "api_request":
      return apiRequest(payload as { path: string; body?: Record<string, any>; body_file?: string });
    case "api_request_body":
      return apiRequest({ path: payload.path, body: JSON.parse(payload.body_json) });
    case "api_request_file":
      return apiRequest({ path: payload.path, body_file: payload.body_file });
    case "api_batch":
      return apiBatch(payload as { path: string; data_file: string; field_map_json: string; output_file: string });
    default:
      throw new Error(`Unknown agents_hub action: ${action}`);
  }
}

export default {
  name: "agents_hub",
  handler: agentsHub,
} satisfies ToolDefinition;
