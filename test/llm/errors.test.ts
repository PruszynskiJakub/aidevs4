import { describe, it, expect } from "bun:test";
import {
  RateLimitError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  InternalServerError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from "openai";
import { isFatalLLMError, extractErrorCode } from "../../src/llm/errors.ts";

// Helper to create OpenAI errors with expected constructor args
function makeAPIError(
  Ctor: new (status: number, error: any, message: string, headers: any) => any,
  status: number,
  body: Record<string, unknown> = {},
  message = "test error",
) {
  return new Ctor(status, body, message, new Headers());
}

describe("isFatalLLMError", () => {
  // ── Fatal errors ─────────────────────────────────────────

  it("classifies AuthenticationError as fatal", () => {
    const err = makeAPIError(AuthenticationError, 401);
    expect(isFatalLLMError(err)).toBe(true);
  });

  it("classifies BadRequestError as fatal", () => {
    const err = makeAPIError(BadRequestError, 400);
    expect(isFatalLLMError(err)).toBe(true);
  });

  it("classifies PermissionDeniedError as fatal", () => {
    const err = makeAPIError(PermissionDeniedError, 403);
    expect(isFatalLLMError(err)).toBe(true);
  });

  it("classifies insufficient_quota RateLimitError as fatal", () => {
    const err = makeAPIError(RateLimitError, 429, { code: "insufficient_quota" });
    expect(isFatalLLMError(err)).toBe(true);
  });

  it("classifies Gemini RESOURCE_EXHAUSTED as fatal", () => {
    const err = new Error("RESOURCE_EXHAUSTED: quota exceeded");
    expect(isFatalLLMError(err)).toBe(true);
  });

  it("classifies Gemini 401 as fatal", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(isFatalLLMError(err)).toBe(true);
  });

  it("classifies Gemini 403 (non-quota) as fatal", () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    expect(isFatalLLMError(err)).toBe(true);
  });

  // ── Transient errors ─────────────────────────────────────

  it("classifies regular RateLimitError as transient", () => {
    const err = makeAPIError(RateLimitError, 429, { code: "rate_limit_exceeded" });
    expect(isFatalLLMError(err)).toBe(false);
  });

  it("classifies InternalServerError as transient", () => {
    const err = makeAPIError(InternalServerError, 500);
    expect(isFatalLLMError(err)).toBe(false);
  });

  it("classifies APIConnectionError as transient", () => {
    const err = new APIConnectionError({ message: "Connection failed" });
    expect(isFatalLLMError(err)).toBe(false);
  });

  it("classifies APIConnectionTimeoutError as transient", () => {
    const err = new APIConnectionTimeoutError();
    expect(isFatalLLMError(err)).toBe(false);
  });

  it("classifies Gemini 500 as transient", () => {
    const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
    expect(isFatalLLMError(err)).toBe(false);
  });

  it("classifies Gemini 503 as transient", () => {
    const err = Object.assign(new Error("Service Unavailable"), { status: 503 });
    expect(isFatalLLMError(err)).toBe(false);
  });

  it("classifies network errors as transient", () => {
    const err = new Error("ECONNRESET");
    expect(isFatalLLMError(err)).toBe(false);
  });

  it("classifies timeout errors as transient", () => {
    const err = new Error("The operation was aborted due to timeout");
    expect(isFatalLLMError(err)).toBe(false);
  });

  it("classifies unknown errors as transient", () => {
    expect(isFatalLLMError(new Error("something unexpected"))).toBe(false);
    expect(isFatalLLMError("string error")).toBe(false);
    expect(isFatalLLMError(null)).toBe(false);
  });
});

describe("extractErrorCode", () => {
  it("extracts code from OpenAI APIError", () => {
    const err = makeAPIError(RateLimitError, 429, { code: "insufficient_quota" });
    expect(extractErrorCode(err)).toBe("insufficient_quota");
  });

  it("falls back to status for OpenAI errors without code", () => {
    const err = makeAPIError(InternalServerError, 500);
    expect(extractErrorCode(err)).toBe("500");
  });

  it("extracts status from Gemini-style errors", () => {
    const err = Object.assign(new Error("Gemini error"), { status: 429 });
    expect(extractErrorCode(err)).toBe("429");
  });

  it("returns undefined for plain errors", () => {
    expect(extractErrorCode(new Error("plain"))).toBeUndefined();
  });

  it("returns undefined for non-Error values", () => {
    expect(extractErrorCode("string")).toBeUndefined();
    expect(extractErrorCode(null)).toBeUndefined();
  });
});
