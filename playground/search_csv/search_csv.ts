import { parse, stringify } from "csv-parse/sync";
import { join } from "path";
import { mkdir } from "fs/promises";

const OUTPUT_DIR = join(import.meta.dir, "output");

type Row = Record<string, string>;

type FilterOp = "eq" | "neq" | "contains" | "startsWith" | "endsWith" | "gt" | "lt" | "gte" | "lte";

interface Filter {
  column: string;
  op: FilterOp;
  value: string;
}

interface SearchCsvRequest {
  path: string;
  filters: Filter[];
}

interface SearchCsvResult {
  rows: Row[];
  outputPath: string;
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

async function searchCsv({ path, filters }: SearchCsvRequest): Promise<SearchCsvResult> {
  const content = await Bun.file(path).text();
  const rows: Row[] = parse(content, { columns: true, skip_empty_lines: true, trim: true });

  const filtered = rows.filter((row) =>
    filters.every(({ column, op, value }) => {
      const cell = row[column];
      if (cell === undefined) throw new Error(`Column "${column}" not found. Available: ${Object.keys(row).join(", ")}`);
      return matchers[op](cell, value);
    })
  );

  await mkdir(OUTPUT_DIR, { recursive: true });
  const filterLabel = filters.map((f) => `${f.column}_${f.op}_${f.value}`).join("__");
  const outputPath = join(OUTPUT_DIR, `results_${filterLabel}.csv`);

  if (filtered.length > 0) {
    const columns = Object.keys(filtered[0]);
    const header = columns.join(",");
    const lines = filtered.map((row) =>
      columns.map((col) => {
        const val = row[col];
        return val.includes(",") || val.includes('"') || val.includes("\n")
          ? `"${val.replace(/"/g, '""')}"`
          : val;
      }).join(",")
    );
    await Bun.write(outputPath, [header, ...lines].join("\n") + "\n");
  } else {
    await Bun.write(outputPath, "");
  }

  return { rows: filtered, outputPath };
}

// --- CLI ---
// Usage: bun run search_csv.ts <path> column:op:value [column:op:value ...]
// Shorthand: column:value  → defaults to eq
// Examples:
//   bun run search_csv.ts data.csv name:eq:Adam gender:eq:M
//   bun run search_csv.ts data.csv birthCountry:Polska birthDate:gt:2000-01-01
//   bun run search_csv.ts data.csv job:contains:programista

const [csvPath, ...filterArgs] = process.argv.slice(2);

if (!csvPath || filterArgs.length === 0) {
  console.error("Usage: bun run search_csv.ts <path> column:op:value [...]");
  console.error("  Ops: eq, neq, contains, startsWith, endsWith, gt, lt, gte, lte");
  console.error("  Shorthand: column:value → eq");
  process.exit(1);
}

const filters: Filter[] = filterArgs.map((arg) => {
  const parts = arg.split(":");
  if (parts.length === 2) return { column: parts[0], op: "eq" as FilterOp, value: parts[1] };
  if (parts.length >= 3) {
    const [column, op, ...rest] = parts;
    if (!(op in matchers)) throw new Error(`Unknown op "${op}". Use: ${Object.keys(matchers).join(", ")}`);
    return { column, op: op as FilterOp, value: rest.join(":") };
  }
  throw new Error(`Invalid filter: "${arg}". Use column:op:value or column:value`);
});

const { rows, outputPath } = await searchCsv({ path: csvPath, filters });

console.log(`Found ${rows.length} rows`);
console.log(`Output: ${outputPath}`);

export { searchCsv, type Filter, type FilterOp, type SearchCsvRequest, type SearchCsvResult };
