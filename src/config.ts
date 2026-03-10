import { join, resolve } from "path";

export const PROJECT_ROOT = resolve(import.meta.dir, "..");
export const OUTPUT_DIR = join(import.meta.dir, "output");

export const ALLOWED_READ_PATHS: string[] = [PROJECT_ROOT];
export const ALLOWED_WRITE_PATHS: string[] = [OUTPUT_DIR];
export const AGENT_MODEL = "gpt-4.1";
export const MAX_ITERATIONS = 20;

export const TRANSFORM_MODEL = "gpt-4.1-mini";
export const TRANSFORM_BATCH_SIZE = 25;

export const HUB_BASE_URL = "https://hub.ag3nts.org";
export const HUB_VERIFY_URL = `${HUB_BASE_URL}/verify`;
