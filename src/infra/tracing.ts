import { config } from "../config/index.ts";

let sdk: { shutdown(): Promise<void> } | null = null;

export function isTracingEnabled(): boolean {
  return !!(config.langfuse.publicKey && config.langfuse.secretKey);
}

export function initTracing(): void {
  if (!isTracingEnabled()) return;

  // Set env vars that LangfuseSpanProcessor reads automatically
  process.env.LANGFUSE_PUBLIC_KEY ??= config.langfuse.publicKey!;
  process.env.LANGFUSE_SECRET_KEY ??= config.langfuse.secretKey!;
  process.env.LANGFUSE_BASEURL ??= config.langfuse.baseUrl;

  try {
    // Dynamic imports to avoid loading OTel when tracing is disabled
    const { NodeSDK } = require("@opentelemetry/sdk-node");
    const { LangfuseSpanProcessor } = require("@langfuse/otel");

    const instance = new NodeSDK({
      spanProcessors: [new LangfuseSpanProcessor()],
    });
    instance.start();
    sdk = instance;
  } catch (err) {
    console.warn("[tracing] Failed to initialize Langfuse tracing:", err);
  }
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (err) {
    console.warn("[tracing] Error during shutdown:", err);
  } finally {
    sdk = null;
  }
}
