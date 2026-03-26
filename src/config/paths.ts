import { join, resolve } from "path";

// src/config/paths.ts lives in src/config/ — project root is two levels up
export const PROJECT_ROOT = resolve(import.meta.dir, "../..");
export const WORKSPACE_DIR = join(PROJECT_ROOT, "workspace");
export const SESSIONS_DIR = join(WORKSPACE_DIR, "sessions");
