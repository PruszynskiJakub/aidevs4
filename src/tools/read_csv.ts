import { readdir, stat } from "fs/promises";
import { join, extname } from "path";

interface CsvStructure {
  file: string;
  rows: number;
  columns: string[];
}

export async function readCsvStructure({ path }: { path: string }): Promise<CsvStructure[]> {
  const info = await stat(path);
  const files: string[] = [];

  if (info.isDirectory()) {
    const entries = await readdir(path);
    for (const entry of entries) {
      if (extname(entry).toLowerCase() === ".csv") {
        files.push(join(path, entry));
      }
    }
    if (files.length === 0) {
      throw new Error(`No CSV files found in directory: ${path}`);
    }
  } else {
    files.push(path);
  }

  const results: CsvStructure[] = [];

  for (const file of files) {
    const content = await Bun.file(file).text();
    const lines = content.trim().split("\n");
    const header = lines[0];
    const columns = header.split(",").map((col) => col.trim().replace(/^"|"$/g, ""));
    const rows = lines.length - 1;

    results.push({ file, rows, columns });
  }

  return results;
}
