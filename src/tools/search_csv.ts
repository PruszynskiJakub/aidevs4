import { parse } from "csv-parse/sync";
import { join } from "path";
import { mkdir } from "fs/promises";
import { OUTPUT_DIR } from "../config.ts";

type Row = Record<string, string>;
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

function toCsvLine(row: Row, columns: string[]): string {
  return columns
    .map((col) => {
      const val = row[col];
      return val.includes(",") || val.includes('"') || val.includes("\n")
        ? `"${val.replace(/"/g, '""')}"`
        : val;
    })
    .join(",");
}

export async function searchCsv({
  path,
  filters,
}: {
  path: string;
  filters: Filter[];
}): Promise<{ matchCount: number; outputPath: string; preview: Row[] }> {
  const content = await Bun.file(path).text();
  const rows: Row[] = parse(content, { columns: true, skip_empty_lines: true, trim: true });

  const filtered = rows.filter((row) =>
    filters.every(({ column, op, value }) => {
      const cell = row[column];
      if (cell === undefined) {
        throw new Error(`Column "${column}" not found. Available: ${Object.keys(row).join(", ")}`);
      }
      return matchers[op](cell, value);
    })
  );

  await mkdir(OUTPUT_DIR, { recursive: true });
  const filterLabel = filters.map((f) => `${f.column}_${f.op}_${f.value}`).join("__");
  const outputPath = join(OUTPUT_DIR, `results_${filterLabel}.csv`);

  if (filtered.length > 0) {
    const columns = Object.keys(filtered[0]);
    const header = columns.join(",");
    const lines = filtered.map((row) => toCsvLine(row, columns));
    await Bun.write(outputPath, [header, ...lines].join("\n") + "\n");
  } else {
    await Bun.write(outputPath, "");
  }

  return {
    matchCount: filtered.length,
    outputPath,
    preview: filtered.slice(0, 5),
  };
}
