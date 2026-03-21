import { join, resolve } from "path";

// src/config/paths.ts lives in src/config/ — project root is two levels up
export const PROJECT_ROOT = resolve(import.meta.dir, "../..");
export const OUTPUT_DIR = join(PROJECT_ROOT, "output");
export const LOGS_DIR = join(PROJECT_ROOT, "logs");
