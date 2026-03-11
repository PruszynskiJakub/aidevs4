import { describe, it, expect } from "bun:test";
import { toolOk, toolError, isToolResponse } from "./tool-response.ts";

describe("toolOk", () => {
  it("produces correct shape without hints", () => {
    const result = toolOk({ filename: "test.txt", path: "/out/test.txt" });
    expect(result).toEqual({
      status: "ok",
      data: { filename: "test.txt", path: "/out/test.txt" },
    });
    expect(result.hints).toBeUndefined();
  });

  it("produces correct shape with hints", () => {
    const result = toolOk({ count: 5 }, ["5 items found."]);
    expect(result).toEqual({
      status: "ok",
      data: { count: 5 },
      hints: ["5 items found."],
    });
  });

  it("omits hints when array is empty", () => {
    const result = toolOk("hello", []);
    expect(result.hints).toBeUndefined();
  });
});

describe("toolError", () => {
  it("produces correct shape without hints", () => {
    const result = toolError("File not found");
    expect(result).toEqual({
      status: "error",
      data: { error: "File not found" },
    });
    expect(result.hints).toBeUndefined();
  });

  it("produces correct shape with hints", () => {
    const result = toolError("File not found", [
      "Hint: check the path or download it first with agents_hub__download.",
    ]);
    expect(result).toEqual({
      status: "error",
      data: { error: "File not found" },
      hints: ["Hint: check the path or download it first with agents_hub__download."],
    });
  });
});

describe("isToolResponse", () => {
  it("returns true for toolOk result", () => {
    expect(isToolResponse(toolOk({ x: 1 }))).toBe(true);
  });

  it("returns true for toolError result", () => {
    expect(isToolResponse(toolError("boom"))).toBe(true);
  });

  it("returns false for plain object", () => {
    expect(isToolResponse({ filename: "test.txt" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isToolResponse(null)).toBe(false);
  });

  it("returns false for string", () => {
    expect(isToolResponse("hello")).toBe(false);
  });

  it("returns false for object with only status (no data)", () => {
    expect(isToolResponse({ status: "ok" })).toBe(false);
  });

  it("returns false for object with invalid status", () => {
    expect(isToolResponse({ status: "unknown", data: {} })).toBe(false);
  });
});
