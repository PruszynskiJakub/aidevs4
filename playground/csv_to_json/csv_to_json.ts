import { parse } from "csv-parse/sync";
import { join } from "path";
import { mkdir } from "fs/promises";

const OUTPUT_DIR = join(import.meta.dir, "output");

type Row = Record<string, string>;

interface ColumnMapping {
  [csvColumn: string]: string;
}

interface CsvToJsonRequest {
  path: string;
  mapping: ColumnMapping;
}

function parseMapping(raw: string): ColumnMapping {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid mapping JSON. Expected format: '{"csv_col":"json_key", ...}'\nReceived: ${raw}`
    );
  }
}

async function csvToJson({ path, mapping }: CsvToJsonRequest): Promise<Record<string, unknown>[]> {
  const content = await Bun.file(path).text();
  const rows: Row[] = parse(content, { columns: true, skip_empty_lines: true, trim: true });

  if (rows.length === 0) throw new Error("CSV file is empty");

  const csvColumns = Object.keys(rows[0]);
  for (const col of Object.keys(mapping)) {
    if (!csvColumns.includes(col)) {
      throw new Error(
        `Column "${col}" not found in CSV. Available: ${csvColumns.join(", ")}`
      );
    }
  }

  const result = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const [csvCol, jsonKey] of Object.entries(mapping)) {
      obj[jsonKey] = row[csvCol];
    }
    return obj;
  });

  await mkdir(OUTPUT_DIR, { recursive: true });
  const baseName = path.split("/").pop()?.replace(/\.csv$/i, "") ?? "output";
  const outputPath = join(OUTPUT_DIR, `${baseName}.json`);
  await Bun.write(outputPath, JSON.stringify(result, null, 2) + "\n");

  console.log(`Converted ${result.length} rows`);
  console.log(`Output: ${outputPath}`);

  return result;
}

// --- CLI ---
// Usage: bun run csv_to_json.ts <csv_path> <mapping_json>
// Example: bun run csv_to_json.ts data.csv '{"name":"fullName","age":"userAge"}'

const [csvPath, mappingRaw] = process.argv.slice(2);

if (!csvPath || !mappingRaw) {
  console.error("Usage: bun run csv_to_json.ts <csv_path> <mapping_json>");
  console.error(`  Example: bun run csv_to_json.ts data.csv '{"name":"fullName","age":"userAge"}'`);
  process.exit(1);
}

const mapping = parseMapping(mappingRaw);
await csvToJson({ path: csvPath, mapping });

export { csvToJson, type CsvToJsonRequest, type ColumnMapping };
