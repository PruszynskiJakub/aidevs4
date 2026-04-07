import { join } from "path";
import { PROJECT_ROOT, WORKSPACE_DIR, SESSIONS_DIR } from "./paths.ts";
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
    workspaceDir: WORKSPACE_DIR,
    sessionsDir: SESSIONS_DIR,
  },
  sandbox: {
    allowedReadPaths: [PROJECT_ROOT] as readonly string[],
    allowedWritePaths: [SESSIONS_DIR, join(WORKSPACE_DIR, "shared"), join(WORKSPACE_DIR, "browser")] as readonly string[],
    webAllowedHosts: [".ag3nts.org"] as readonly string[],
  },
  models: {
    agent: "gpt-4.1",
    transform: "gpt-4.1-mini",
    gemini: "gemini-3-flash-preview",
    memory: "gpt-4.1-mini",
  },
  hub: {
    baseUrl: HUB_BASE_URL,
    verifyUrl: `${HUB_BASE_URL}/verify`,
    apiKey: env.hubApiKey,
  },
  keys: {
    openaiApiKey: env.openaiApiKey,
    geminiApiKey: env.geminiApiKey,
    serperApiKey: env.serperApiKey,
  },
  urls: {
    serperScrape: "https://scrape.serper.dev",
  },
  limits: {
    maxIterations: 40,
    fetchTimeout: 30_000,
    maxBatchRows: 1000,
    maxFileSize: 10 * 1024 * 1024,
    transformBatchSize: 25,
    openaiTimeout: 60_000,
    geminiTimeout: 60_000,
    docMaxFiles: 10,
  },
  server: {
    port: env.port,
    apiSecret: env.apiSecret,
  },
  memory: {
    observationThreshold: 30_000,
    reflectionThreshold: 40_000,
    reflectionTarget: 20_000,
    tailBudgetRatio: 0.3,
    maxReflectionLevels: 3,
    truncationLimits: {
      message: 6_000,
      toolPayload: 3_000,
    },
  },
  moderation: {
    enabled: true,
  },
  langfuse: {
    publicKey: env.langfusePublicKey,
    secretKey: env.langfuseSecretKey,
    baseUrl: env.langfuseBaseUrl ?? "https://cloud.langfuse.com",
  },
  retry: {
    openaiMaxRetries: 2,
    geminiMaxAttempts: 5,
  },
  browser: {
    headless: env.browserHeadless,
    sessionPath: join(WORKSPACE_DIR, "browser", "session.json"),
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    pagesDir: join(WORKSPACE_DIR, "browser", "pages"),
    timeouts: {
      navigation: 30_000,
      action: 5_000,
      evaluate: 30_000,
      screenshot: 10_000,
      settleAfterClick: 1_500,
      settleAfterType: 2_000,
      settleAfterNavigation: 2_000,
    },
    structMaxNodes: 1_000,
    structMaxDepth: 8,
    textMaxLines: 500,
    screenshotMaxBytes: 1_048_576,
    maxPoolSize: 3,
    idleTimeout: 5 * 60_000,
  },
  database: {
    url: env.databaseUrl,
  },
  assistant: env.assistant,
});
