import { parse } from "csv-parse/sync";

export type Row = Record<string, string>;

export async function parseCsv(filePath: string): Promise<Row[]> {
  const content = await Bun.file(filePath).text();
  return parse(content, { columns: true, skip_empty_lines: true, trim: true });
}

export function toCsvLine(row: Row, columns: string[]): string {
  return columns
    .map((col) => {
      const val = row[col];
      return val.includes(",") || val.includes('"') || val.includes("\n")
        ? `"${val.replace(/"/g, '""')}"`
        : val;
    })
    .join(",");
}

export async function writeCsv(rows: Row[], outputPath: string): Promise<void> {
  if (rows.length === 0) {
    await Bun.write(outputPath, "");
    return;
  }

  const columns = Object.keys(rows[0]);
  const header = columns.join(",");
  const lines = rows.map((row) => toCsvLine(row, columns));
  await Bun.write(outputPath, [header, ...lines].join("\n") + "\n");
}
