import {
  APIError,
  RateLimitError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
} from "openai";

/**
 * Returns true for LLM errors that will never succeed on retry — billing,
 * auth, or malformed request issues. Transient errors (rate limits, server
 * errors, timeouts) return false.
 *
 * Classification table: see _specs/SP-70-llm-retry-and-error-classification.md
 */
export function isFatalLLMError(err: unknown): boolean {
  // OpenAI SDK error classes
  if (err instanceof AuthenticationError) return true;
  if (err instanceof BadRequestError) return true;
  if (err instanceof PermissionDeniedError) return true;

  // OpenAI insufficient_quota: RateLimitError with code "insufficient_quota"
  if (err instanceof RateLimitError) {
    return err.code === "insufficient_quota";
  }

  // Gemini errors — no typed classes, inspect status and message
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    const msg = err.message;

    // Gemini RESOURCE_EXHAUSTED (quota)
    if (msg.includes("RESOURCE_EXHAUSTED")) return true;

    // Gemini 400 Bad Request — malformed input, will never succeed on retry
    if (status === 400) return true;

    // Gemini auth/permission errors
    if (status === 401 || status === 403) {
      // 403 with RESOURCE_EXHAUSTED is quota (caught above),
      // other 403 is permission denied
      return true;
    }
  }

  return false;
}

/**
 * Extracts a short error code string for event payloads.
 */
export function extractErrorCode(err: unknown): string | undefined {
  if (err instanceof APIError) {
    return err.code ?? (err.status ? String(err.status) : undefined);
  }

  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    if (status) return String(status);
  }

  return undefined;
}
