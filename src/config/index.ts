import { join, resolve } from "path";

// src/config/index.ts lives in src/config/ — project root is two levels up
const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const OUTPUT_DIR = join(PROJECT_ROOT, "src/output");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

// Validate all required env vars upfront — collect all missing, don't fail on first
const REQUIRED_VARS = ["HUB_API_KEY", "OPENAI_API_KEY"] as const;
const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(", ")}`,
  );
}

const HUB_BASE_URL = "https://hub.ag3nts.org";

export const config = deepFreeze({
  paths: {
    projectRoot: PROJECT_ROOT,
    outputDir: OUTPUT_DIR,
    logsDir: LOGS_DIR,
  },
  sandbox: {
    allowedReadPaths: [PROJECT_ROOT] as readonly string[],
    allowedWritePaths: [OUTPUT_DIR, LOGS_DIR] as readonly string[],
    webAllowedHosts: [".ag3nts.org"] as readonly string[],
  },
  models: {
    agent: "gpt-4.1",
    transform: "gpt-4.1-mini",
    gemini: "gemini-2.5-flash",
  },
  hub: {
    baseUrl: HUB_BASE_URL,
    verifyUrl: `${HUB_BASE_URL}/verify`,
    apiKey: requireEnv("HUB_API_KEY"),
  },
  keys: {
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    geminiApiKey: process.env.GEMINI_API_KEY as string | undefined,
  },
  limits: {
    maxIterations: 20,
    fetchTimeout: 30_000,
    maxBatchRows: 1000,
    maxFileSize: 10 * 1024 * 1024,
    transformBatchSize: 25,
    geminiTimeout: 60_000,
    docMaxFiles: 10,
  },
  web: {
    placeholderMap: {
      hub_api_key: () => config.hub.apiKey,
    } as Record<string, () => string>,
  },
  server: {
    port: Number(process.env.PORT) || 3000,
  },
  persona: process.env.PERSONA as string | undefined,
});

export default config;