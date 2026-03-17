import { join, resolve } from "path";

export const PROJECT_ROOT = resolve(import.meta.dir, "..");
export const OUTPUT_DIR = join(import.meta.dir, "output");

export const ALLOWED_READ_PATHS: string[] = [PROJECT_ROOT];
export const LOGS_DIR = join(PROJECT_ROOT, "logs");
export const ALLOWED_WRITE_PATHS: string[] = [OUTPUT_DIR, LOGS_DIR];
export const AGENT_MODEL = "gpt-4.1";
export const MAX_ITERATIONS = 20;

export const TRANSFORM_MODEL = "gpt-4.1-mini";
export const TRANSFORM_BATCH_SIZE = 25;

export const HUB_BASE_URL = "https://hub.ag3nts.org";
export const HUB_VERIFY_URL = `${HUB_BASE_URL}/verify`;

export const FETCH_TIMEOUT = 30_000;
export const MAX_BATCH_ROWS = 1000;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

export const WEB_ALLOWED_HOSTS: string[] = [".ag3nts.org"];

export const WEB_PLACEHOLDER_MAP: Record<string, () => string> = {
  hub_api_key: () => {
    const key = process.env.HUB_API_KEY;
    if (!key) throw new Error("HUB_API_KEY environment variable is not set");
    return key;
  },
};

export const GEMINI_MODEL = "gemini-2.5-flash";
export const GEMINI_TIMEOUT = 60_000;
export const DOC_MAX_FILES = 10;
