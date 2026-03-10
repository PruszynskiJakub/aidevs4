import { join, extname } from "path";
import { files } from "../services/file.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { type Row, parseCsv, writeCsv } from "../utils/csv.ts";
import { batchTransform } from "../utils/llm.ts";
import { ensureOutputDir, outputPath } from "../utils/output.ts";

// --- metadata ---

interface CsvStructure {
  file: string;
  rows: number;
  columns: string[];
}

async function metadata(payload: { path: string }): Promise<CsvStructure[]> {
  const info = await files.stat(payload.path);
  const csvFiles: string[] = [];

  if (info.isDirectory) {
    const entries = await files.readdir(payload.path);
    for (const entry of entries) {
      if (extname(entry).toLowerCase() === ".csv") {
        csvFiles.push(join(payload.path, entry));
      }
    }
    if (csvFiles.length === 0) {
      throw new Error(`No CSV files found in directory: ${payload.path}`);
    }
  } else {
    csvFiles.push(payload.path);
  }

  const results: CsvStructure[] = [];

  for (const file of csvFiles) {
    const content = await files.readText(file);
    const lines = content.trim().split("\n");
    const header = lines[0];
    const columns = header.split(",").map((col) => col.trim().replace(/^"|"$/g, ""));
    const rows = lines.length - 1;

    results.push({ file, rows, columns });
  }

  return results;
}

// --- search ---

type FilterOp = "eq" | "neq" | "contains" | "startsWith" | "endsWith" | "gt" | "lt" | "gte" | "lte";

interface Filter {
  column: string;
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

async function search(payload: {
  path: string;
  filters: Filter[];
}): Promise<{ matchCount: number; outputPath: string; preview: Row[] }> {
  const rows = await parseCsv(payload.path);

  const filtered = rows.filter((row) =>
    payload.filters.every(({ column, op, value }) => {
      const cell = row[column];
      if (cell === undefined) {
        throw new Error(`Column "${column}" not found. Available: ${Object.keys(row).join(", ")}`);
      }
      return matchers[op](cell, value);
    })
  );

  await ensureOutputDir();
  const filterLabel = payload.filters.map((f) => `${f.column}_${f.op}_${f.value}`).join("__");
  const outPath = outputPath(`results_${filterLabel}.csv`);

  await writeCsv(filtered, outPath);

  return {
    matchCount: filtered.length,
    outputPath: outPath,
    preview: filtered.slice(0, 5),
  };
}

// --- transform_column ---

async function transformColumn(payload: {
  path: string;
  column_name: string;
  instructions: string;
}): Promise<{ rowCount: number; outputPath: string; preview: Row[] }> {
  const rows = await parseCsv(payload.path);

  if (rows.length === 0) throw new Error("CSV file is empty");
  if (!(payload.column_name in rows[0])) {
    throw new Error(
      `Column "${payload.column_name}" not found. Available: ${Object.keys(rows[0]).join(", ")}`
    );
  }

  const values = rows.map((row) => row[payload.column_name]);

  console.log(`Transforming ${values.length} values in column "${payload.column_name}"...`);
  const transformed = await batchTransform(values, payload.instructions);

  const updatedRows = rows.map((row, idx) => ({
    ...row,
    [payload.column_name]: transformed[idx],
  }));

  await ensureOutputDir();
  const outPath = outputPath(`transformed_${payload.column_name}.csv`);

  await writeCsv(updatedRows, outPath);

  return {
    rowCount: updatedRows.length,
    outputPath: outPath,
    preview: updatedRows.slice(0, 5),
  };
}

// --- dispatcher ---

const VALID_ACTIONS = ["metadata", "search", "transform_column"] as const;
type Action = (typeof VALID_ACTIONS)[number];

const actionHandlers: Record<Action, (payload: any) => Promise<unknown>> = {
  metadata,
  search,
  transform_column: transformColumn,
};

async function csvProcessor({ action, payload }: { action: string; payload: unknown }): Promise<unknown> {
  if (!VALID_ACTIONS.includes(action as Action)) {
    throw new Error(`Unknown action "${action}". Valid actions: ${VALID_ACTIONS.join(", ")}`);
  }
  return actionHandlers[action as Action](payload);
}

export default {
  name: "csv_processor",
  handler: csvProcessor,
} satisfies ToolDefinition;
