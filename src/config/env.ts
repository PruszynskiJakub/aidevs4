function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Validate all required env vars upfront — collect all missing, don't fail on first
const REQUIRED_VARS = ["HUB_API_KEY", "OPENAI_API_KEY"] as const;
const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(", ")}`,
  );
}

export const env = {
  hubApiKey: requireEnv("HUB_API_KEY"),
  openaiApiKey: requireEnv("OPENAI_API_KEY"),
  geminiApiKey: process.env.GEMINI_API_KEY,
  serperApiKey: process.env.SERPER_API_KEY,
  port: Number(process.env.PORT) || 3000,
  assistant: process.env.ASSISTANT ?? process.env.PERSONA,
} as const;
