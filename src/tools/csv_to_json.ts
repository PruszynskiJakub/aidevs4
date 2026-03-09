import { parse } from "csv-parse/sync";
import { join } from "path";
import { mkdir } from "fs/promises";
import { OUTPUT_DIR } from "../config.ts";

type Row = Record<string, string>;

interface ColumnMapping {
  from: string;
  to: string;
}

interface CsvToJsonArgs {
  path: string;
  mapping: ColumnMapping[];
}

export async function csvToJson({
  path,
  mapping,
}: CsvToJsonArgs): Promise<{ rowCount: number; outputPath: string; preview: Record<string, string>[] }> {
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
    const obj: Record<string, string> = {};
    for (const { from, to } of mapping) {
      obj[to] = row[from];
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
