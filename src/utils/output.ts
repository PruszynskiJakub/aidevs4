import { join } from "path";
import { files } from "../services/file.ts";
import { OUTPUT_DIR } from "../config.ts";

export async function ensureOutputDir(): Promise<void> {
  await files.mkdir(OUTPUT_DIR);
}

export function outputPath(filename: string): string {
  return join(OUTPUT_DIR, filename);
}
