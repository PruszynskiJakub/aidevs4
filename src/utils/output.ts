import { join } from "path";
import { mkdir } from "fs/promises";
import { OUTPUT_DIR } from "../config.ts";

export async function ensureOutputDir(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

export function outputPath(filename: string): string {
  return join(OUTPUT_DIR, filename);
}
