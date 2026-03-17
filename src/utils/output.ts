import { join } from "path";
import { files } from "../services/file.ts";
import { config } from "../config/index.ts";

export async function ensureOutputDir(): Promise<void> {
  await files.mkdir(config.paths.outputDir);
}

export function outputPath(filename: string): string {
  return join(config.paths.outputDir, filename);
}
