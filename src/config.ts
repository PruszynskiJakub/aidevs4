import { join } from "path";

export const OUTPUT_DIR = join(import.meta.dir, "output");
export const AGENT_MODEL = "gpt-4.1";
export const MAX_ITERATIONS = 20;

export const TRANSFORM_MODEL = "gpt-4.1-mini";
export const TRANSFORM_BATCH_SIZE = 25;

export const HUB_VERIFY_URL = "https://hub.ag3nts.org/verify";
