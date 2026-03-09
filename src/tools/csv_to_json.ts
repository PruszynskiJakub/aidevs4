import type { ToolDefinition } from "../types/tool.ts";
import { parseCsv } from "../utils/csv.ts";
import { ensureOutputDir, outputPath } from "../utils/output.ts";

interface ColumnMapping {
  from: string;
  to: string;
  type?: "string" | "number" | "json";
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

async function csvToJson({
  path,
  mapping,
}: {
  path: string;
  mapping: ColumnMapping[];
}): Promise<{ rowCount: number; outputPath: string; preview: Record<string, unknown>[] }> {
  const rows = await parseCsv(path);

  if (rows.length === 0) throw new Error("CSV file is empty");

  const csvColumns = Object.keys(rows[0]);
  for (const { from } of mapping) {
    if (!csvColumns.includes(from)) {
      throw new Error(
        `Column "${from}" not found in CSV. Available: ${csvColumns.join(", ")}`
      );
    }
  }

  const result = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const { from, to, type } of mapping) {
      obj[to] = convertValue(row[from], type);
    }
    return obj;
  });

  await ensureOutputDir();
  const baseName = path.split("/").pop()?.replace(/\.csv$/i, "") ?? "output";
  const outPath = outputPath(`${baseName}.json`);
  await Bun.write(outPath, JSON.stringify(result, null, 2) + "\n");

  return {
    rowCount: result.length,
    outputPath: outPath,
    preview: result.slice(0, 5),
  };
}

export default {
  name: "csv_to_json",
  handler: csvToJson,
} satisfies ToolDefinition;
