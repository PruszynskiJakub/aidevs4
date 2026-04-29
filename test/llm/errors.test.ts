import { describe, it, expect } from "bun:test";
import {
  RateLimitError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  InternalServerError,
  APIConnectionError,
  APIConnectionTimeoutError,
  NotFoundError,
  ConflictError,
} from "openai";
import { toOpenAIDomainError } from "../../src/llm/openai.ts";
import { toGeminiDomainError } from "../../src/llm/gemini.ts";
import { isDomainError } from "../../src/types/errors.ts";

// Helper to construct OpenAI SDK errors with the expected ctor signature.
function makeAPIError(
  Ctor: new (status: number, error: any, message: string, headers: any) => any,
  status: number,
  body: Record<string, unknown> = {},
  message = "test error",
) {
  return new Ctor(status, body, message, new Headers());
}

describe("toOpenAIDomainError", () => {
  it("maps AuthenticationError to type=auth", () => {
    const out = toOpenAIDomainError(makeAPIError(AuthenticationError, 401));
    expect(isDomainError(out)).toBe(true);
    expect(out.type).toBe("auth");
  });

  it("maps BadRequestError to type=validation", () => {
    expect(toOpenAIDomainError(makeAPIError(BadRequestError, 400)).type).toBe("validation");
  });

  it("maps PermissionDeniedError to type=permission", () => {
    expect(toOpenAIDomainError(makeAPIError(PermissionDeniedError, 403)).type).toBe("permission");
  });

  it("maps NotFoundError to type=not_found", () => {
    expect(toOpenAIDomainError(makeAPIError(NotFoundError, 404)).type).toBe("not_found");
  });

  it("maps ConflictError to type=conflict", () => {
    expect(toOpenAIDomainError(makeAPIError(ConflictError, 409)).type).toBe("conflict");
  });

  it("maps insufficient_quota RateLimitError to type=auth (fatal)", () => {
    const out = toOpenAIDomainError(
      makeAPIError(RateLimitError, 429, { code: "insufficient_quota" }),
    );
    expect(out.type).toBe("auth");
  });

  it("maps regular RateLimitError to type=capacity (transient)", () => {
    const out = toOpenAIDomainError(
      makeAPIError(RateLimitError, 429, { code: "rate_limit_exceeded" }),
    );
    expect(out.type).toBe("capacity");
  });

  it("maps InternalServerError to type=provider", () => {
    const out = toOpenAIDomainError(makeAPIError(InternalServerError, 500));
    expect(out.type).toBe("provider");
    expect(out.provider).toBe("openai");
  });

  it("maps APIConnectionError to type=provider", () => {
    const out = toOpenAIDomainError(new APIConnectionError({ message: "Connection failed" }));
    expect(out.type).toBe("provider");
    expect(out.provider).toBe("openai");
  });

  it("maps APIConnectionTimeoutError to type=timeout", () => {
    expect(toOpenAIDomainError(new APIConnectionTimeoutError()).type).toBe("timeout");
  });

  it("re-passes existing DomainError unchanged", () => {
    const original = toOpenAIDomainError(makeAPIError(AuthenticationError, 401));
    const out = toOpenAIDomainError(original);
    expect(out).toBe(original);
  });

  it("maps unknown errors to type=provider with cause preserved", () => {
    const root = new Error("something unexpected");
    const out = toOpenAIDomainError(root);
    expect(out.type).toBe("provider");
    expect(out.cause).toBe(root);
  });

  it("maps non-Error values to type=provider", () => {
    expect(toOpenAIDomainError("string error").type).toBe("provider");
    expect(toOpenAIDomainError(null).type).toBe("provider");
  });
});

describe("toGeminiDomainError", () => {
  it("maps RESOURCE_EXHAUSTED message to type=auth (quota)", () => {
    expect(toGeminiDomainError(new Error("RESOURCE_EXHAUSTED: quota exceeded")).type).toBe("auth");
  });

  it("maps status=400 to type=validation", () => {
    const err = Object.assign(new Error("Bad request"), { status: 400 });
    expect(toGeminiDomainError(err).type).toBe("validation");
  });

  it("maps status=401 to type=auth", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(toGeminiDomainError(err).type).toBe("auth");
  });

  it("maps status=403 (non-quota) to type=permission", () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    expect(toGeminiDomainError(err).type).toBe("permission");
  });

  it("maps status=429 to type=capacity", () => {
    const err = Object.assign(new Error("Too many requests"), { status: 429 });
    expect(toGeminiDomainError(err).type).toBe("capacity");
  });

  it("maps status=500 to type=provider", () => {
    const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const out = toGeminiDomainError(err);
    expect(out.type).toBe("provider");
    expect(out.provider).toBe("gemini");
  });

  it("maps status=503 to type=provider", () => {
    const err = Object.assign(new Error("Service Unavailable"), { status: 503 });
    expect(toGeminiDomainError(err).type).toBe("provider");
  });

  it("maps AbortError to type=timeout", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(toGeminiDomainError(err).type).toBe("timeout");
  });

  it("maps network errors without status to type=provider", () => {
    expect(toGeminiDomainError(new Error("ECONNRESET")).type).toBe("provider");
  });

  it("re-passes existing DomainError unchanged", () => {
    const original = toGeminiDomainError(new Error("RESOURCE_EXHAUSTED"));
    const out = toGeminiDomainError(original);
    expect(out).toBe(original);
  });

  it("preserves the original error as cause", () => {
    const root = new Error("RESOURCE_EXHAUSTED");
    const out = toGeminiDomainError(root);
    expect(out.cause).toBe(root);
  });
});
