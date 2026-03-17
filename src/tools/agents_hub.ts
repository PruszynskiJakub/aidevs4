import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResponse } from "../types/tool.ts";
import { files } from "../services/file.ts";
import { getApiKey } from "../utils/hub.ts";
import { config } from "../config/index.ts";
import { parseCsv } from "../utils/csv.ts";
import { safeParse, validateKeys, assertMaxLength, checkFileSize } from "../utils/parse.ts";
import { toolOk } from "../utils/tool-response.ts";

async function verify(payload: { task: string; answer_file: string }): Promise<ToolResponse> {
  assertMaxLength(payload.task, "task", 100);
  assertMaxLength(payload.answer_file, "answer_file", 500);

  const apiKey = getApiKey();

  await checkFileSize(payload.answer_file, config.limits.maxFileSize);
  const content = await files.readText(payload.answer_file);
  const answer = safeParse(content, "answer_file");

  const body = { apikey: apiKey, task: payload.task, answer };

  const res = await fetch(config.hub.verifyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.limits.fetchTimeout),
  });

  const response = await res.json().catch(() => res.text());

  if (!res.ok) {
    const detail = typeof response === "string" ? response : JSON.stringify(response);
    throw new Error(`Verify failed (${res.status}): ${detail}`);
  }

  return toolOk(
    { task: payload.task, response },
    [`Verification submitted for task '${payload.task}'.`],
  );
}

async function apiRequest(payload: {
  path: string;
  body?: Record<string, any>;
  body_file?: string;
}): Promise<ToolResponse> {
  assertMaxLength(payload.path, "path", 200);

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
    assertMaxLength(payload.body_file!, "body_file", 500);
    await checkFileSize(payload.body_file!, config.limits.maxFileSize);
    const content = await files.readText(payload.body_file!);
    body = safeParse(content, "body_file");
  } else {
    body = { ...payload.body };
  }

  const apiKey = getApiKey();
  body.apikey = apiKey;

  const url = `${config.hub.baseUrl}/api/${payload.path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.limits.fetchTimeout),
  });

  const contentType = res.headers.get("content-type") || "";
  const response = contentType.includes("application/json")
    ? await res.json()
    : await res.text();

  if (!res.ok) {
    const detail = typeof response === "string" ? response : JSON.stringify(response);
    throw new Error(`API request failed (${res.status}): ${detail}`);
  }

  return toolOk(
    { path: payload.path, response },
    [`Response from /api/${payload.path} received.`],
  );
}

async function apiBatch(payload: {
  path: string;
  data_file: string;
  field_map_json: string;
  output_file: string;
}): Promise<ToolResponse> {
  assertMaxLength(payload.path, "path", 200);
  assertMaxLength(payload.data_file, "data_file", 500);
  assertMaxLength(payload.field_map_json, "field_map_json", 100_000);
  assertMaxLength(payload.output_file, "output_file", 500);

  const fieldMap: Record<string, string> = safeParse(payload.field_map_json, "field_map_json");
  validateKeys(fieldMap);

  await checkFileSize(payload.data_file, config.limits.maxFileSize);

  let rows: Record<string, any>[];
  if (payload.data_file.endsWith(".csv")) {
    rows = await parseCsv(payload.data_file);
  } else {
    const content = await files.readText(payload.data_file);
    const parsed = safeParse<unknown>(content, "data_file");
    if (!Array.isArray(parsed)) {
      throw new Error("JSON data file must contain an array");
    }
    rows = parsed;
  }

  if (rows.length > config.limits.maxBatchRows) {
    throw new Error(`Batch size ${rows.length} exceeds maximum of ${config.limits.maxBatchRows} rows`);
  }

  const apiKey = getApiKey();
  const url = `${config.hub.baseUrl}/api/${payload.path}`;
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
      signal: AbortSignal.timeout(config.limits.fetchTimeout),
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

  return toolOk(
    { path: payload.path, count: results.length, output_file: payload.output_file },
    [`Processed ${results.length} rows. Results written to ${payload.output_file}.`],
  );
}

async function agentsHub({ action, payload }: { action: string; payload: Record<string, any> }): Promise<unknown> {
  switch (action) {
    case "verify":
      return verify(payload as { task: string; answer_file: string });
    case "api_request":
      return apiRequest(payload as { path: string; body?: Record<string, any>; body_file?: string });
    case "api_request_body": {
      assertMaxLength(payload.body_json, "body_json", 100_000);
      assertMaxLength(payload.path, "path", 200);
      return apiRequest({ path: payload.path, body: safeParse(payload.body_json, "body_json") });
    }
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
