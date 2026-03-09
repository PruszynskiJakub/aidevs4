import type { ToolDefinition } from "../types/tool.ts";
import { type Row, parseCsv, writeCsv } from "../utils/csv.ts";
import { ensureOutputDir, outputPath } from "../utils/output.ts";

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

async function searchCsv({
  path,
  filters,
}: {
  path: string;
  filters: Filter[];
}): Promise<{ matchCount: number; outputPath: string; preview: Row[] }> {
  const rows = await parseCsv(path);

  const filtered = rows.filter((row) =>
    filters.every(({ column, op, value }) => {
      const cell = row[column];
      if (cell === undefined) {
        throw new Error(`Column "${column}" not found. Available: ${Object.keys(row).join(", ")}`);
      }
      return matchers[op](cell, value);
    })
  );

  await ensureOutputDir();
  const filterLabel = filters.map((f) => `${f.column}_${f.op}_${f.value}`).join("__");
  const outPath = outputPath(`results_${filterLabel}.csv`);

  await writeCsv(filtered, outPath);

  return {
    matchCount: filtered.length,
    outputPath: outPath,
    preview: filtered.slice(0, 5),
  };
}

export default {
  name: "search_csv",
  handler: searchCsv,
} satisfies ToolDefinition;
