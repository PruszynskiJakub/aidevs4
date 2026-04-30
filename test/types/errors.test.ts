import { describe, it, expect } from "bun:test";
import {
  DomainError,
  isDomainError,
  toHttpStatus,
  type DomainErrorType,
} from "../../apps/server/src/types/errors.ts";

describe("DomainError", () => {
  it("constructs with type and message", () => {
    const e = new DomainError({ type: "validation", message: "Bad input" });
    expect(e.type).toBe("validation");
    expect(e.message).toBe("Bad input");
    expect(e.name).toBe("DomainError");
    expect(e instanceof Error).toBe(true);
  });

  it("preserves internalMessage and provider fields", () => {
    const e = new DomainError({
      type: "provider",
      message: "Upstream broke",
      internalMessage: "OpenAI 503: server overloaded",
      provider: "openai",
    });
    expect(e.internalMessage).toBe("OpenAI 503: server overloaded");
    expect(e.provider).toBe("openai");
  });

  it("forwards cause to Error.cause", () => {
    const root = new SyntaxError("Unexpected token");
    const e = new DomainError({
      type: "validation",
      message: "Invalid JSON",
      cause: root,
    });
    expect(e.cause).toBe(root);
  });

  it("does not set cause when not provided", () => {
    const e = new DomainError({ type: "validation", message: "Bad input" });
    expect(e.cause).toBeUndefined();
  });
});

describe("isDomainError", () => {
  it("returns true for DomainError instances", () => {
    const e = new DomainError({ type: "validation", message: "x" });
    expect(isDomainError(e)).toBe(true);
  });

  it("returns false for plain Error", () => {
    expect(isDomainError(new Error("plain"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isDomainError(null)).toBe(false);
    expect(isDomainError(undefined)).toBe(false);
    expect(isDomainError("string")).toBe(false);
    expect(isDomainError({ type: "validation", message: "x" })).toBe(false);
    expect(isDomainError(42)).toBe(false);
  });
});

describe("toHttpStatus", () => {
  const cases: Array<[DomainErrorType, number]> = [
    ["validation", 400],
    ["auth", 401],
    ["permission", 403],
    ["not_found", 404],
    ["conflict", 409],
    ["capacity", 429],
    ["provider", 502],
    ["timeout", 504],
  ];

  for (const [type, status] of cases) {
    it(`maps "${type}" to ${status}`, () => {
      expect(toHttpStatus(type)).toBe(status);
    });
  }
});
