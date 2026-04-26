import { describe, it, expect } from "bun:test";
import { resolveUri } from "../../src/utils/uri.ts";

describe("resolveUri", () => {
  it("converts file:// URI to absolute path", () => {
    expect(resolveUri("file:///tmp/f.txt")).toBe("/tmp/f.txt");
  });

  it("decodes percent-encoded characters", () => {
    expect(resolveUri("file:///tmp/my%20file.txt")).toBe("/tmp/my file.txt");
  });

  it("throws on unsupported scheme", () => {
    expect(() => resolveUri("https://example.com")).toThrow("Unsupported URI scheme");
  });

  it("throws on invalid URI", () => {
    expect(() => resolveUri("not a uri")).toThrow("Invalid URI");
  });

  it("handles nested paths", () => {
    expect(resolveUri("file:///home/user/workspace/sessions/2026-03-30/abc/output/file.txt"))
      .toBe("/home/user/workspace/sessions/2026-03-30/abc/output/file.txt");
  });
});
