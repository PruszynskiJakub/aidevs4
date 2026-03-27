import { z } from "zod";
import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { files } from "../infra/file.ts";
import { config } from "../config/index.ts";
import { safeParse, validateKeys, assertMaxLength } from "../utils/parse.ts";
import { createDocument } from "../infra/document.ts";
import { HUB_DOC_META, hubPost, stringify } from "../utils/hub-fetch.ts";
import { getSessionId } from "../agent/context.ts";

async function verify(payload: { task: string; answer: string }): Promise<Document> {
  assertMaxLength(payload.task, "task", 100);
  assertMaxLength(payload.answer, "answer", 100_000);

  const answer = await files.resolveInput(payload.answer, "answer");
  const response = await hubPost(
    config.hub.verifyUrl,
    { apikey: config.hub.apiKey, task: payload.task, answer },
    "Verify failed",
    config.limits.fetchTimeout,
  );

  return createDocument(stringify(response), `Verification result for task '${payload.task}'`, HUB_DOC_META, getSessionId());
}

async function apiRequest(payload: {
  path: string;
  body: string;
}): Promise<Document> {
  assertMaxLength(payload.path, "path", 200);
  assertMaxLength(payload.body, "body", 100_000);

  const resolved = await files.resolveInput(payload.body, "body");
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) {
    throw new Error("body must resolve to a JSON object");
  }

  const url = `${config.hub.baseUrl}/api/${payload.path}`;
  const response = await hubPost(
    url,
    { ...(resolved as Record<string, unknown>), apikey: config.hub.apiKey },
    "API request failed",
    config.limits.fetchTimeout,
  );

  return createDocument(stringify(response), `Response from /api/${payload.path}`, HUB_DOC_META, getSessionId());
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

  await files.checkFileSize(payload.data_file, config.limits.maxFileSize);

  let rows: Record<string, unknown>[];
  const content = await files.readText(payload.data_file);
  const parsed = safeParse<unknown>(content, "data_file");
  if (!Array.isArray(parsed)) {
    throw new Error("JSON data file must contain an array");
  }
  rows = parsed;

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
      const response = await hubPost(url, mapped, "API batch request failed", config.limits.fetchTimeout);
      results.push({ input: row, response });
    } catch (err) {
      results.push({ input: row, response: err instanceof Error ? err.message : String(err) });
      await files.write(payload.output_file, JSON.stringify(results, null, 2));
      throw new Error(`API batch request failed at row ${results.length} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await files.write(payload.output_file, JSON.stringify(results, null, 2));

  return results.map((r, i) =>
    createDocument(stringify(r.response), `Batch row ${i + 1}/${results.length} from /api/${payload.path}`, HUB_DOC_META, getSessionId()),
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

  const answers = await files.resolveInput(payload.answers, "answers");

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
        config.limits.fetchTimeout,
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
    createDocument(stringify(r.response), `Verify batch item ${r.index} for task '${payload.task}'`, HUB_DOC_META, getSessionId()),
  );
}

async function agentsHub(args: Record<string, unknown>): Promise<Document | Document[]> {
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
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
  schema: {
    name: "agents_hub",
    description: "Submit answers and call APIs on the AG3NTS hub platform (hub.ag3nts.org). Use after you have prepared an answer or need hub data to solve a task.",
    actions: {
      verify: {
        description: "Submit a single answer for verification. Returns the hub response (typically a flag or status message). For tasks requiring multiple sequential submissions (e.g. classifying N items one by one), use verify_batch instead.",
        schema: z.object({
          task: z.string().describe('The task name to verify against (e.g. "people")'),
          answer: z.string().describe("The answer to submit — file path to a JSON file, inline JSON string, or a raw string value"),
        }),
      },
      verify_batch: {
        description: "Submit multiple answers for verification SEQUENTIALLY (one after another). Use when the hub expects ordered submissions — e.g. classifying N items where each call advances an internal counter. Answers are sent in array order. Stops on first HTTP error. Returns array of {index, answer, response} written to output_file.",
        schema: z.object({
          task: z.string().describe('The task name to verify against (e.g. "categorize")'),
          answers: z.string().describe("Array of answers — file path to a JSON array file, or an inline JSON array string"),
          output_file: z.string().describe("Absolute path to write the results JSON array (each entry has index, answer, response)"),
        }),
      },
      api_request: {
        description: "POST to /api/* with a JSON body. Returns the API response body as JSON. For a single call only — if calling the same endpoint for each item in a dataset, use api_batch instead.",
        schema: z.object({
          path: z.string().describe('API path segment after /api/ (e.g. "location")'),
          body: z.string().describe("Request body — file path to a JSON file, inline JSON string, or a raw string value. apikey is injected automatically."),
        }),
      },
      api_batch: {
        description: "POST to /api/* for each row in a CSV/JSON array file. Preferred over multiple api_request calls — use whenever a dataset needs the same endpoint called per item. Apikey auto-injected. Calls made sequentially. Returns array of {input, response} per row written to output_file.",
        schema: z.object({
          path: z.string().describe('API path segment after /api/ (e.g. "location")'),
          data_file: z.string().describe("Absolute path to a CSV or JSON array file. Each row/item becomes one API call."),
          field_map_json: z.string().describe('JSON object mapping source field names to target field names, e.g. {"born":"birthYear"}. Unmapped fields pass through. Default: "{}" (no renaming).'),
          output_file: z.string().describe("Absolute path to write the results JSON array"),
        }),
      },
    },
  },
  handler: agentsHub,
} satisfies ToolDefinition;
