import { describe, it, expect, beforeEach, mock } from "bun:test";
import { moderateInput, assertNotFlagged, _setClient } from "../../src/infra/guard.ts";
import type { ModerationResult } from "../../src/types/moderation.ts";

function makeFakeClient(overrides: {
  flagged?: boolean;
  categories?: Record<string, boolean>;
  category_scores?: Record<string, number>;
  shouldThrow?: Error;
}) {
  return {
    moderations: {
      create: overrides.shouldThrow
        ? mock(() => Promise.reject(overrides.shouldThrow))
        : mock(() =>
            Promise.resolve({
              results: [
                {
                  flagged: overrides.flagged ?? false,
                  categories: overrides.categories ?? {},
                  category_scores: overrides.category_scores ?? {},
                },
              ],
            }),
          ),
    },
  } as any;
}

beforeEach(() => {
  _setClient(undefined);
});

describe("moderateInput", () => {
  it("returns not flagged for clean input", async () => {
    const client = makeFakeClient({
      flagged: false,
      categories: { hate: false, violence: false },
      category_scores: { hate: 0.001, violence: 0.002 },
    });
    _setClient(client);

    const result = await moderateInput("Hello, how are you?");

    expect(result.flagged).toBe(false);
    expect(result.categories.hate).toBe(false);
    expect(client.moderations.create).toHaveBeenCalledTimes(1);
  });

  it("returns flagged with categories for violating input", async () => {
    const client = makeFakeClient({
      flagged: true,
      categories: { hate: true, violence: false, "self-harm": true },
      category_scores: { hate: 0.95, violence: 0.01, "self-harm": 0.88 },
    });
    _setClient(client);

    const result = await moderateInput("some violating text");

    expect(result.flagged).toBe(true);
    expect(result.categories.hate).toBe(true);
    expect(result.categories["self-harm"]).toBe(true);
    expect(result.categories.violence).toBe(false);
    expect(result.categoryScores.hate).toBe(0.95);
  });

  it("fails open on API error", async () => {
    const client = makeFakeClient({
      shouldThrow: new Error("Network timeout"),
    });
    _setClient(client);

    const result = await moderateInput("anything");

    expect(result.flagged).toBe(false);
    expect(result.categories).toEqual({});
  });
});

describe("assertNotFlagged", () => {
  it("does not throw for clean result", () => {
    const result: ModerationResult = {
      flagged: false,
      categories: { hate: false },
      categoryScores: { hate: 0.001 },
    };

    expect(() => assertNotFlagged(result)).not.toThrow();
  });

  it("throws with category names for flagged result", () => {
    const result: ModerationResult = {
      flagged: true,
      categories: { hate: true, violence: false, "self-harm": true },
      categoryScores: { hate: 0.95, violence: 0.01, "self-harm": 0.88 },
    };

    expect(() => assertNotFlagged(result)).toThrow(
      "Input blocked by moderation policy. Violated categories: hate, self-harm",
    );
  });

  it("throws for single flagged category", () => {
    const result: ModerationResult = {
      flagged: true,
      categories: { violence: true },
      categoryScores: { violence: 0.99 },
    };

    expect(() => assertNotFlagged(result)).toThrow("violence");
  });
});
