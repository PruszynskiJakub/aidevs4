import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { files } from "../services/common/file.ts";
import { config } from "../config/index.ts";
import { parseCsv } from "../utils/csv.ts";
import { safeParse, validateKeys, assertMaxLength, checkFileSize, resolveInput } from "../utils/parse.ts";
import { createDocument } from "../utils/document.ts";
import { hubPost, stringify } from "../utils/hub-fetch.ts";

async function verify(payload: { task: string; answer: string }): Promise<Document> {
  assertMaxLength(payload.task, "task", 100);
  assertMaxLength(payload.answer, "answer", 100_000);

  const answer = await resolveInput(payload.answer, "answer");
  const response = await hubPost(
    config.hub.verifyUrl,
    { apikey: config.hub.apiKey, task: payload.task, answer },
    "Verify failed",
  );

  return createDocument(stringify(response), `Verification result for task '${payload.task}'`, {
    source: "hub.ag3nts.org",
    type: "document",
    mimeType: "application/json",
  });
}

async function apiRequest(payload: {
  path: string;
  body: string;
}): Promise<Document> {
  assertMaxLength(payload.path, "path", 200);
  assertMaxLength(payload.body, "body", 100_000);

  const resolved = await resolveInput(payload.body, "body");
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) {
    throw new Error("body must resolve to a JSON object");
  }

  const url = `${config.hub.baseUrl}/api/${payload.path}`;
  const response = await hubPost(
    url,
    { ...(resolved as Record<string, unknown>), apikey: config.hub.apiKey },
    "API request failed",
  );

  return createDocument(stringify(response), `Response from /api/${payload.path}`, {
    source: "hub.ag3nts.org",
    type: "document",
    mimeType: "application/json",
  });
}

async function apiBatch(payload: {
  path: string;
  data_file: string;
  field_map_json: string;
  output_file: string;
}): Promise<Document[]> {
  assertMaxLength(payload.path, "path", 200);
  assertMaxLength(payload.data_file, "data_file", 500);
  assertMaxLength(payload.field_map_json, "field_map_json", 100_000);
  assertMaxLength(payload.output_file, "output_file", 500);

  const fieldMap: Record<string, string> = safeParse(payload.field_map_json, "field_map_json");
  validateKeys(fieldMap);

  await checkFileSize(payload.data_file, config.limits.maxFileSize);

  let rows: Record<string, unknown>[];
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

  const url = `${config.hub.baseUrl}/api/${payload.path}`;
  const results: { input: Record<string, unknown>; response: unknown }[] = [];

  for (const row of rows) {
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      const targetKey = fieldMap[key] ?? key;
      mapped[targetKey] = value;
    }
    mapped.apikey = config.hub.apiKey;

    try {
      const response = await hubPost(url, mapped, "API batch request failed");
      results.push({ input: row, response });
    } catch (err) {
      results.push({ input: row, response: err instanceof Error ? err.message : String(err) });
      await files.write(payload.output_file, JSON.stringify(results, null, 2));
      throw new Error(`API batch request failed at row ${results.length} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await files.write(payload.output_file, JSON.stringify(results, null, 2));

  return results.map((r, i) =>
    createDocument(stringify(r.response), `Batch row ${i + 1}/${results.length} from /api/${payload.path}`, {
      source: "hub.ag3nts.org",
      type: "document",
      mimeType: "application/json",
    }),
  );
}

async function verifyBatch(payload: {
  task: string;
  answers: string;
  output_file: string;
}): Promise<Document[]> {
  assertMaxLength(payload.task, "task", 100);
  assertMaxLength(payload.answers, "answers", 100_000);
  assertMaxLength(payload.output_file, "output_file", 500);

  const answers = await resolveInput(payload.answers, "answers");

  if (!Array.isArray(answers)) {
    throw new Error("answers must resolve to a JSON array of answer objects");
  }
  if (answers.length > config.limits.maxBatchRows) {
    throw new Error(`Batch size ${answers.length} exceeds maximum of ${config.limits.maxBatchRows}`);
  }

  const results: { index: number; answer: unknown; response: unknown }[] = [];

  for (let i = 0; i < answers.length; i++) {
    try {
      const response = await hubPost(
        config.hub.verifyUrl,
        { apikey: config.hub.apiKey, task: payload.task, answer: answers[i] },
        "Verify batch failed",
      );
      results.push({ index: i, answer: answers[i], response });
    } catch (err) {
      results.push({ index: i, answer: answers[i], response: err instanceof Error ? err.message : String(err) });
      await files.write(payload.output_file, JSON.stringify(results, null, 2));
      throw new Error(`Verify batch failed at item ${i} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await files.write(payload.output_file, JSON.stringify(results, null, 2));

  return results.map((r) =>
    createDocument(stringify(r.response), `Verify batch item ${r.index} for task '${payload.task}'`, {
      source: "hub.ag3nts.org",
      type: "document",
      mimeType: "application/json",
    }),
  );
}

async function agentsHub({ action, payload }: { action: string; payload: Record<string, unknown> }): Promise<Document | Document[]> {
  switch (action) {
    case "verify":
      return verify(payload as { task: string; answer: string });
    case "verify_batch":
      return verifyBatch(payload as { task: string; answers: string; output_file: string });
    case "api_request":
      return apiRequest(payload as { path: string; body: string });
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
