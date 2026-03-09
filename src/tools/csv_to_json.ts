import { parse } from "csv-parse/sync";
import { join } from "path";
import { mkdir } from "fs/promises";
import { OUTPUT_DIR } from "../config.ts";

type Row = Record<string, string>;

interface ColumnMapping {
  from: string;
  to: string;
  type?: "string" | "number" | "json";
}

interface CsvToJsonArgs {
  path: string;
  mapping: ColumnMapping[];
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

export async function csvToJson({
  path,
  mapping,
}: CsvToJsonArgs): Promise<{ rowCount: number; outputPath: string; preview: Record<string, unknown>[] }> {
  const content = await Bun.file(path).text();
  const rows: Row[] = parse(content, { columns: true, skip_empty_lines: true, trim: true });

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

  await mkdir(OUTPUT_DIR, { recursive: true });
  const baseName = path.split("/").pop()?.replace(/\.csv$/i, "") ?? "output";
  const outputPath = join(OUTPUT_DIR, `${baseName}.json`);
  await Bun.write(outputPath, JSON.stringify(result, null, 2) + "\n");

  return {
    rowCount: result.length,
    outputPath,
    preview: result.slice(0, 5),
  };
}
