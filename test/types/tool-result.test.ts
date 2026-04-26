import { describe, it, expect } from "bun:test";
import { text, error, resource } from "../../src/types/tool-result.ts";

describe("text()", () => {
  it("creates ToolResult with single text part", () => {
    const result = text("hello");
    expect(result).toEqual({ content: [{ type: "text", text: "hello" }] });
  });
});

describe("error()", () => {
  it("creates ToolResult with isError flag", () => {
    const result = error("fail");
    expect(result).toEqual({ content: [{ type: "text", text: "fail" }], isError: true });
  });
});

describe("resource()", () => {
  it("creates ResourceRef with uri and description", () => {
    const ref = resource("file:///tmp/f.txt", "Full content");
    expect(ref).toEqual({ type: "resource", uri: "file:///tmp/f.txt", description: "Full content" });
  });

  it("includes optional mimeType", () => {
    const ref = resource("file:///tmp/f.txt", "Full content", "text/plain");
    expect(ref).toEqual({ type: "resource", uri: "file:///tmp/f.txt", description: "Full content", mimeType: "text/plain" });
  });
});
