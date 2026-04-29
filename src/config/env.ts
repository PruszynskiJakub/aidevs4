import { DomainError } from "../types/errors.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new DomainError({ type: "validation", message: `Missing required environment variable: ${name}` });
  return value;
}

// Validate all required env vars upfront — collect all missing, don't fail on first
const REQUIRED_VARS = ["HUB_API_KEY", "OPENAI_API_KEY"] as const;
const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new DomainError({
    type: "validation",
    message: `Missing required environment variable(s): ${missing.join(", ")}`,
  });
}

const nodeEnv = (process.env.NODE_ENV ?? "development") as "development" | "production";

const defaultDbPath = nodeEnv === "production" ? "./data/prod.db" : "./data/dev.db";

export const env = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  hubApiKey: requireEnv("HUB_API_KEY"),
  openaiApiKey: requireEnv("OPENAI_API_KEY"),
  geminiApiKey: process.env.GEMINI_API_KEY,
  serperApiKey: process.env.SERPER_API_KEY,
  port: Number(process.env.PORT) || 3000,
  assistant: process.env.ASSISTANT ?? process.env.PERSONA,
  langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY,
  langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY,
  langfuseBaseUrl: process.env.LANGFUSE_BASE_URL,
  langfuseEnvironment: process.env.LANGFUSE_ENVIRONMENT ?? nodeEnv,
  browserHeadless: process.env.BROWSER_HEADLESS !== "false",
  apiSecret: process.env.API_SECRET,
  databaseUrl: process.env.DATABASE_URL ?? defaultDbPath,
} as const;
