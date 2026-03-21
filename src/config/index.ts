import { PROJECT_ROOT, OUTPUT_DIR, LOGS_DIR } from "./paths.ts";
import { env } from "./env.ts";

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
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
    gemini: "gemini-3-flash-preview",
  },
  hub: {
    baseUrl: HUB_BASE_URL,
    verifyUrl: `${HUB_BASE_URL}/verify`,
    apiKey: env.hubApiKey,
  },
  keys: {
    openaiApiKey: env.openaiApiKey,
    geminiApiKey: env.geminiApiKey,
  },
  limits: {
    maxIterations: 40,
    fetchTimeout: 30_000,
    maxBatchRows: 1000,
    maxFileSize: 10 * 1024 * 1024,
    transformBatchSize: 25,
    geminiTimeout: 60_000,
    docMaxFiles: 10,
  },
  server: {
    port: env.port,
  },
  assistant: env.assistant,
});
