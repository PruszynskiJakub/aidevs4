import { parse } from "csv-parse/sync";
import { join } from "path";
import { mkdir } from "fs/promises";
import OpenAI from "openai";

const OUTPUT_DIR = join(import.meta.dir, "output");

type Row = Record<string, string>;

interface TransformCsvRequest {
  path: string;
  column_name: string;
  instructions: string;
}

interface TransformCsvResult {
  rows: Row[];
  outputPath: string;
}

const openai = new OpenAI();

async function transformValues(values: string[], instructions: string): Promise<string[]> {
  const BATCH_SIZE = 25;
  const results: string[] = [];

  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const batch = values.slice(i, i + BATCH_SIZE);
    const numbered = batch.map((v, idx) => `${i + idx + 1}. ${v}`).join("\n");

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `For each numbered text below, apply the following instructions and return the result. Return ONLY the numbered results, one per line, in the format: NUMBER. RESULT\n\nInstructions: ${instructions}`,
        },
        { role: "user", content: numbered },
      ],
    });

    const text = response.choices[0].message.content ?? "";
    const tags = text
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\d+\.\s*/, "").trim());

    if (tags.length !== batch.length) {
      throw new Error(
        `LLM returned ${tags.length} results but expected ${batch.length}. Response:\n${text}`
      );
    }

    results.push(...tags);
    if (i + BATCH_SIZE < values.length) {
      console.log(`Processed ${Math.min(i + BATCH_SIZE, values.length)}/${values.length} rows...`);
    }
  }

  return results;
}

async function transformCsv({
  path,
  column_name,
  instructions,
}: TransformCsvRequest): Promise<TransformCsvResult> {
  const content = await Bun.file(path).text();
  const rows: Row[] = parse(content, { columns: true, skip_empty_lines: true, trim: true });

  if (rows.length === 0) throw new Error("CSV file is empty");
  if (!(column_name in rows[0]))
    throw new Error(
      `Column "${column_name}" not found. Available: ${Object.keys(rows[0]).join(", ")}`
    );

  const values = rows.map((row) => row[column_name]);

  console.log(`Transforming ${values.length} values in column "${column_name}"...`);
  const transformed = await transformValues(values, instructions);

  const updatedRows = rows.map((row, idx) => ({
    ...row,
    [column_name]: transformed[idx],
  }));

  await mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = join(OUTPUT_DIR, `transformed_${column_name}.csv`);

  const columns = Object.keys(updatedRows[0]);
  const header = columns.join(",");
  const lines = updatedRows.map((row) =>
    columns
      .map((col) => {
        const val = row[col];
        return val.includes(",") || val.includes('"') || val.includes("\n")
          ? `"${val.replace(/"/g, '""')}"`
          : val;
      })
      .join(",")
  );
  await Bun.write(outputPath, [header, ...lines].join("\n") + "\n");

  return { rows: updatedRows, outputPath };
}

// --- CLI ---
// Usage: bun run transform_csv.ts <path> <column_name> <instructions>
// Example: bun run transform_csv.ts data.csv job "Return a single short tag (1-3 words) describing the profession"

const [csvPath, columnName, instructions] = process.argv.slice(2);

if (!csvPath || !columnName || !instructions) {
  console.error("Usage: bun run transform_csv.ts <path> <column_name> <instructions>");
  console.error('  Example: bun run transform_csv.ts data.csv job "Return a short tag for the profession"');
  process.exit(1);
}

const { rows, outputPath } = await transformCsv({
  path: csvPath,
  column_name: columnName,
  instructions,
});

console.log(`Transformed ${rows.length} rows`);
console.log(`Output: ${outputPath}`);

export { transformCsv, type TransformCsvRequest, type TransformCsvResult };
