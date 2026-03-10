import { join, extname } from "path";
import { files } from "../services/file.ts";
import type { ToolDefinition } from "../types/tool.ts";

interface CsvStructure {
  file: string;
  rows: number;
  columns: string[];
}

async function readCsvStructure({ path }: { path: string }): Promise<CsvStructure[]> {
  const info = await files.stat(path);
  const csvFiles: string[] = [];

  if (info.isDirectory) {
    const entries = await files.readdir(path);
    for (const entry of entries) {
      if (extname(entry).toLowerCase() === ".csv") {
        csvFiles.push(join(path, entry));
      }
    }
    if (csvFiles.length === 0) {
      throw new Error(`No CSV files found in directory: ${path}`);
    }
  } else {
    csvFiles.push(path);
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

export default {
  name: "read_csv_structure",
  handler: readCsvStructure,
} satisfies ToolDefinition;
