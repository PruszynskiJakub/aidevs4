import type { ToolDefinition } from "../types/tool.ts";
import { type Row, parseCsv, writeCsv } from "../utils/csv.ts";
import { batchTransform } from "../utils/llm.ts";
import { ensureOutputDir, outputPath } from "../utils/output.ts";

async function transformCsv({
  path,
  column_name,
  instructions,
}: {
  path: string;
  column_name: string;
  instructions: string;
}): Promise<{ rowCount: number; outputPath: string; preview: Row[] }> {
  const rows = await parseCsv(path);

  if (rows.length === 0) throw new Error("CSV file is empty");
  if (!(column_name in rows[0])) {
    throw new Error(
      `Column "${column_name}" not found. Available: ${Object.keys(rows[0]).join(", ")}`
    );
  }

  const values = rows.map((row) => row[column_name]);

  console.log(`Transforming ${values.length} values in column "${column_name}"...`);
  const transformed = await batchTransform(values, instructions);

  const updatedRows = rows.map((row, idx) => ({
    ...row,
    [column_name]: transformed[idx],
  }));

  await ensureOutputDir();
  const outPath = outputPath(`transformed_${column_name}.csv`);

  await writeCsv(updatedRows, outPath);

  return {
    rowCount: updatedRows.length,
    outputPath: outPath,
    preview: updatedRows.slice(0, 5),
  };
}

export default {
  name: "transform_csv",
  handler: transformCsv,
} satisfies ToolDefinition;
