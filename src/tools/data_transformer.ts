import type { ToolDefinition } from "../types/tool.ts";
import { files } from "../services/file.ts";
import { parseCsv, writeCsv, toCsvLine, type Row } from "../utils/csv.ts";
import { batchTransform } from "../utils/llm.ts";
import { ensureOutputDir, outputPath } from "../utils/output.ts";

// --- shared helpers ---

async function loadRecords(path: string, format: "csv" | "json"): Promise<Record<string, string>[]> {
  if (format === "csv") {
    return parseCsv(path);
  }
  const data = await files.readJson<unknown>(path);
  if (!Array.isArray(data)) {
    throw new Error(`JSON file must contain an array of objects`);
  }
  return data.map((item: Record<string, unknown>) => {
    const record: Record<string, string> = {};
    for (const [key, val] of Object.entries(item)) {
      record[key] = val == null ? "" : typeof val === "object" ? JSON.stringify(val) : String(val);
    }
    return record;
  });
}

async function writeRecords(
  records: Record<string, string>[],
  format: "csv" | "json",
  filename: string,
): Promise<string> {
  await ensureOutputDir();
  const outPath = outputPath(filename);
  if (format === "csv") {
    await writeCsv(records, outPath);
  } else {
    await files.write(outPath, JSON.stringify(records, null, 2) + "\n");
  }
  return outPath;
}

// --- filter ---

type FilterOp = "eq" | "neq" | "contains" | "startsWith" | "endsWith" | "gt" | "lt" | "gte" | "lte";

interface Condition {
  field: string;
  op: FilterOp;
  value: string;
}

const matchers: Record<FilterOp, (cell: string, value: string) => boolean> = {
  eq: (c, v) => c === v,
  neq: (c, v) => c !== v,
  contains: (c, v) => c.toLowerCase().includes(v.toLowerCase()),
  startsWith: (c, v) => c.toLowerCase().startsWith(v.toLowerCase()),
  endsWith: (c, v) => c.toLowerCase().endsWith(v.toLowerCase()),
  gt: (c, v) => c > v,
  lt: (c, v) => c < v,
  gte: (c, v) => c >= v,
  lte: (c, v) => c <= v,
};

async function filter(payload: {
  path: string;
  format: "csv" | "json";
  conditions: Condition[];
  logic: "and" | "or";
}): Promise<{ count: number; outputPath: string; preview: Record<string, string>[] }> {
  const records = await loadRecords(payload.path, payload.format);

  const filtered = records.filter((row) => {
    const results = payload.conditions.map(({ field, op, value }) => {
      const cell = row[field];
      if (cell === undefined) {
        throw new Error(`Field "${field}" not found. Available: ${Object.keys(row).join(", ")}`);
      }
      return matchers[op](cell, value);
    });
    return payload.logic === "and" ? results.every(Boolean) : results.some(Boolean);
  });

  const label = payload.conditions.map((c) => `${c.field}_${c.op}_${c.value}`).join("__");
  const ext = payload.format === "csv" ? "csv" : "json";
  const outPath = await writeRecords(filtered, payload.format, `filtered_${label}.${ext}`);

  return {
    count: filtered.length,
    outputPath: outPath,
    preview: filtered.slice(0, 5),
  };
}

// --- sort ---

interface SortCriterion {
  field: string;
  direction: "asc" | "desc";
}

function compareValues(a: string, b: string): number {
  const numA = Number(a);
  const numB = Number(b);
  if (!isNaN(numA) && !isNaN(numB) && a !== "" && b !== "") {
    return numA - numB;
  }
  return a.localeCompare(b);
}

async function sort(payload: {
  path: string;
  format: "csv" | "json";
  sort_by: SortCriterion[];
}): Promise<{ count: number; outputPath: string; preview: Record<string, string>[] }> {
  const records = await loadRecords(payload.path, payload.format);

  const sorted = [...records].sort((a, b) => {
    for (const { field, direction } of payload.sort_by) {
      const cmp = compareValues(a[field] ?? "", b[field] ?? "");
      if (cmp !== 0) return direction === "asc" ? cmp : -cmp;
    }
    return 0;
  });

  const ext = payload.format === "csv" ? "csv" : "json";
  const fields = payload.sort_by.map((s) => `${s.field}_${s.direction}`).join("__");
  const outPath = await writeRecords(sorted, payload.format, `sorted_${fields}.${ext}`);

  return {
    count: sorted.length,
    outputPath: outPath,
    preview: sorted.slice(0, 5),
  };
}

// --- add_field ---

async function addField(payload: {
  path: string;
  format: "csv" | "json";
  field_name: string;
  instructions: string;
  context_fields: string[];
}): Promise<{ count: number; outputPath: string; preview: Record<string, string>[] }> {
  const records = await loadRecords(payload.path, payload.format);
  if (records.length === 0) throw new Error("File contains no records");

  const contextStrings = records.map((row) =>
    payload.context_fields.map((f) => `${f}: ${row[f] ?? ""}`).join(", "),
  );

  console.log(`Generating "${payload.field_name}" for ${records.length} records...`);
  const generated = await batchTransform(contextStrings, payload.instructions);

  const updated = records.map((row, i) => ({
    ...row,
    [payload.field_name]: generated[i],
  }));

  const ext = payload.format === "csv" ? "csv" : "json";
  const outPath = await writeRecords(updated, payload.format, `added_${payload.field_name}.${ext}`);

  return {
    count: updated.length,
    outputPath: outPath,
    preview: updated.slice(0, 5),
  };
}

// --- convert ---

interface ColumnMapping {
  from: string;
  to: string;
  type?: "string" | "number" | "json";
}

function stringifyValue(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function convertValue(value: string, type: string = "string"): unknown {
  switch (type) {
    case "number":
      return Number(value);
    case "json":
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    default:
      return value;
  }
}

async function convertCsvToJson(
  sourcePath: string,
  mapping?: ColumnMapping[],
): Promise<{ count: number; outputPath: string; preview: Record<string, unknown>[] }> {
  const rows = await parseCsv(sourcePath);
  if (rows.length === 0) throw new Error("CSV file is empty");

  let result: Record<string, unknown>[];

  if (mapping && mapping.length > 0) {
    const csvColumns = Object.keys(rows[0]);
    for (const { from } of mapping) {
      if (!csvColumns.includes(from)) {
        throw new Error(`Column "${from}" not found in CSV. Available: ${csvColumns.join(", ")}`);
      }
    }
    result = rows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (const { from, to, type } of mapping) {
        obj[to] = convertValue(row[from], type);
      }
      return obj;
    });
  } else {
    result = rows.map((row) => ({ ...row }));
  }

  await ensureOutputDir();
  const baseName = sourcePath.split("/").pop()?.replace(/\.csv$/i, "") ?? "output";
  const outPath = outputPath(`${baseName}.json`);
  await files.write(outPath, JSON.stringify(result, null, 2) + "\n");

  return {
    count: result.length,
    outputPath: outPath,
    preview: result.slice(0, 5),
  };
}

async function convertJsonToCsv(
  sourcePath: string,
  mapping?: ColumnMapping[],
): Promise<{ count: number; outputPath: string; preview: string }> {
  const data = await files.readJson<Record<string, unknown>[]>(sourcePath);
  if (!Array.isArray(data)) {
    throw new Error(`JSON file must contain an array of objects`);
  }
  if (data.length === 0) throw new Error("JSON array is empty");

  let rows: Row[];

  if (mapping && mapping.length > 0) {
    rows = data.map((obj) => {
      const row: Row = {};
      for (const { from, to } of mapping) {
        row[to] = stringifyValue(obj[from]);
      }
      return row;
    });
  } else {
    rows = data.map((obj) => {
      const row: Row = {};
      for (const [key, val] of Object.entries(obj)) {
        row[key] = stringifyValue(val);
      }
      return row;
    });
  }

  await ensureOutputDir();
  const baseName = sourcePath.split("/").pop()?.replace(/\.json$/i, "") ?? "output";
  const outPath = outputPath(`${baseName}.csv`);
  await writeCsv(rows, outPath);

  const previewRows = rows.slice(0, 5);
  const columns = Object.keys(rows[0]);
  const previewLines = [columns.join(","), ...previewRows.map((r) => toCsvLine(r, columns))];

  return {
    count: rows.length,
    outputPath: outPath,
    preview: previewLines.join("\n"),
  };
}

async function convert(payload: {
  source_path: string;
  from_format: "csv" | "json";
  to_format: "csv" | "json";
  mapping?: ColumnMapping[];
}): Promise<{ count: number; outputPath: string; preview: unknown }> {
  const { source_path, from_format, to_format, mapping } = payload;

  if (from_format === "csv" && to_format === "json") {
    return convertCsvToJson(source_path, mapping);
  }
  if (from_format === "json" && to_format === "csv") {
    return convertJsonToCsv(source_path, mapping);
  }

  throw new Error(`Unsupported conversion: ${from_format} → ${to_format}. Supported: csv→json, json→csv`);
}

// --- action router ---

const VALID_ACTIONS = ["filter", "sort", "add_field", "convert"] as const;
type Action = (typeof VALID_ACTIONS)[number];

const actionHandlers: Record<Action, (payload: any) => Promise<unknown>> = {
  filter,
  sort,
  add_field: addField,
  convert,
};

async function dataTransformer({ action, payload }: { action: string; payload: unknown }): Promise<unknown> {
  if (!VALID_ACTIONS.includes(action as Action)) {
    throw new Error(`Unknown action "${action}". Valid actions: ${VALID_ACTIONS.join(", ")}`);
  }
  return actionHandlers[action as Action](payload);
}

export default {
  name: "data_transformer",
  handler: dataTransformer,
} satisfies ToolDefinition;
