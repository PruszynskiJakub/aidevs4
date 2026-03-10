import type { ToolDefinition } from "../types/tool.ts";
import { files } from "../services/file.ts";
import { parseCsv, writeCsv, toCsvLine, type Row } from "../utils/csv.ts";
import { ensureOutputDir, outputPath } from "../utils/output.ts";

interface ColumnMapping {
  from: string;
  to: string;
  type?: "string" | "number" | "json";
}

interface ConverterArgs {
  source_path: string;
  from_format: "csv" | "json";
  to_format: "csv" | "json";
  mapping?: ColumnMapping[];
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

async function csvToJson(
  sourcePath: string,
  mapping?: ColumnMapping[],
): Promise<{ rowCount: number; outputPath: string; preview: Record<string, unknown>[] }> {
  const rows = await parseCsv(sourcePath);
  if (rows.length === 0) throw new Error("CSV file is empty");

  let result: Record<string, unknown>[];

  if (mapping && mapping.length > 0) {
    const csvColumns = Object.keys(rows[0]);
    for (const { from } of mapping) {
      if (!csvColumns.includes(from)) {
        throw new Error(
          `Column "${from}" not found in CSV. Available: ${csvColumns.join(", ")}`,
        );
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
    rowCount: result.length,
    outputPath: outPath,
    preview: result.slice(0, 5),
  };
}

async function jsonToCsv(
  sourcePath: string,
  mapping?: ColumnMapping[],
): Promise<{ rowCount: number; outputPath: string; preview: string }> {
  const data = await files.readJson<Record<string, unknown>[]>(sourcePath);
  if (!Array.isArray(data)) {
    const keys = typeof data === "object" && data !== null ? Object.keys(data).slice(0, 10) : [];
    throw new Error(
      `JSON file must contain an array of objects, but got ${typeof data}` +
      (keys.length ? ` with top-level keys: ${keys.join(", ")}. Use read_file to inspect the structure first.` : ""),
    );
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
  const previewLines = [
    columns.join(","),
    ...previewRows.map((r) => toCsvLine(r, columns)),
  ];

  return {
    rowCount: rows.length,
    outputPath: outPath,
    preview: previewLines.join("\n"),
  };
}

async function fileConverter(args: ConverterArgs) {
  const { source_path, from_format, to_format, mapping } = args;

  if (from_format === "csv" && to_format === "json") {
    return csvToJson(source_path, mapping);
  }
  if (from_format === "json" && to_format === "csv") {
    return jsonToCsv(source_path, mapping);
  }

  throw new Error(
    `Unsupported conversion: ${from_format} → ${to_format}. Supported: csv→json, json→csv`,
  );
}

export default {
  name: "file_converter",
  handler: fileConverter,
} satisfies ToolDefinition;
