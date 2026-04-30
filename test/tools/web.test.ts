import { describe, it, expect, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ToolResult } from "../../apps/server/src/types/tool-result.ts";
import web from "../../apps/server/src/tools/web.ts";
import { config } from "../../apps/server/src/config/index.ts";
import { createSandbox, _setSandboxForTest } from "../../apps/server/src/infra/sandbox.ts";

const handler = web.handler;

let tmp: string;
let restoreFiles: () => void;
const originalFetch = globalThis.fetch;

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  for (const part of result.content) {
    if (part.type === "text") return part.text;
  }
  return "";
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "web-test-"));
  restoreFiles = _setSandboxForTest(
    createSandbox({
      readPaths: [...config.sandbox.allowedReadPaths, tmp],
      writePaths: [...config.sandbox.allowedWritePaths, tmp],
      blockedWritePaths: [],
    }),
  );
});

afterAll(async () => {
  restoreFiles();
  await rm(tmp, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

describe("web download", () => {
  it("resolves hub_api_key placeholder, fetches, and writes file", async () => {
    let capturedUrl = "";

    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response("file-content", { status: 200 });
    }) as any;

    const result = await handler({
      action: "download",
      payload: {
        url: "https://hub.ag3nts.org/data/{{hub_api_key}}/people.csv",
        filename: "people.csv",
      },
    });

    expect(capturedUrl).toBe(`https://hub.ag3nts.org/data/${config.hub.apiKey}/people.csv`);
    expect(getText(result)).toContain("File saved to");
    expect(getText(result)).toMatch(/\.csv/);
    // Should have a resource ref
    const hasResource = result.content.some(p => p.type === "resource");
    expect(hasResource).toBe(true);
  });

  it("downloads without placeholders", async () => {
    let capturedUrl = "";

    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response("data", { status: 200 });
    }) as any;

    const result = await handler({
      action: "download",
      payload: {
        url: "https://centrala.ag3nts.org/files/report.txt",
        filename: "report.txt",
      },
    });

    expect(capturedUrl).toBe("https://centrala.ag3nts.org/files/report.txt");
    expect(getText(result)).toContain("File saved to");
  });

  it("passes unknown placeholders through unchanged", async () => {
    let capturedUrl = "";

    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response("data", { status: 200 });
    }) as any;

    await handler({
      action: "download",
      payload: {
        url: "https://hub.ag3nts.org/data/{{unknown_key}}/file.txt",
        filename: "file.txt",
      },
    });

    expect(capturedUrl).toBe("https://hub.ag3nts.org/data/{{unknown_key}}/file.txt");
  });

  it("throws on disallowed host", async () => {
    await expect(
      handler({
        action: "download",
        payload: {
          url: "https://evil.example.com/malware.exe",
          filename: "safe.txt",
        },
      }),
    ).rejects.toThrow('Host "evil.example.com" is not on the allowlist');
  });

  it("rejects path traversal in filename", async () => {
    await expect(
      handler({
        action: "download",
        payload: {
          url: "https://hub.ag3nts.org/file.txt",
          filename: "../etc/passwd",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects hidden files in filename", async () => {
    await expect(
      handler({
        action: "download",
        payload: {
          url: "https://hub.ag3nts.org/file.txt",
          filename: ".hidden",
        },
      }),
    ).rejects.toThrow("hidden file");
  });

  it("throws on empty URL", async () => {
    await expect(
      handler({
        action: "download",
        payload: {
          url: "",
          filename: "file.txt",
        },
      }),
    ).rejects.toThrow("Invalid URL");
  });

  it("throws on non-2xx response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404 });
    }) as any;

    await expect(
      handler({
        action: "download",
        payload: {
          url: "https://hub.ag3nts.org/missing.txt",
          filename: "missing.txt",
        },
      }),
    ).rejects.toThrow("Download failed (404)");
  });

  it("throws on URL exceeding max length", async () => {
    const longUrl = "https://hub.ag3nts.org/" + "a".repeat(2048);

    await expect(
      handler({
        action: "download",
        payload: {
          url: longUrl,
          filename: "file.txt",
        },
      }),
    ).rejects.toThrow("url exceeds max length");
  });

  it("throws on unknown action", async () => {
    await expect(
      handler({
        action: "nonexistent",
        payload: {},
      }),
    ).rejects.toThrow("Unknown web action: nonexistent");
  });
});

describe("web scrape", () => {
  it("scrapes a single URL and returns ToolResult with text", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ text: "Hello from page" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({
      action: "scrape",
      payload: { urls: ["https://example.com/page"] },
    });

    expect(getText(result)).toContain("Hello from page");
    expect(getText(result)).toContain("example.com/page");
  });

  it("scrapes multiple URLs in parallel", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      return new Response(JSON.stringify({ text: `Page ${callCount}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({
      action: "scrape",
      payload: { urls: ["https://a.com", "https://b.com", "https://c.com"] },
    });

    expect(callCount).toBe(3);
    // All summaries in one text part
    expect(result.content.length).toBeGreaterThanOrEqual(1);
  });

  it("handles partial failure — one bad URL does not block others", async () => {
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.url === "https://bad.com") {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(JSON.stringify({ text: "OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({
      action: "scrape",
      payload: { urls: ["https://good.com", "https://bad.com"] },
    });

    const t = getText(result);
    expect(t).toContain("OK");
    expect(t).toContain("Error");
  });

  it("rejects empty urls array", async () => {
    await expect(
      handler({ action: "scrape", payload: { urls: [] } }),
    ).rejects.toThrow("non-empty array");
  });

  it("rejects invalid URL format", async () => {
    await expect(
      handler({ action: "scrape", payload: { urls: ["not-a-url"] } }),
    ).rejects.toThrow("Invalid URL format");
  });

  it("rejects URL exceeding max length", async () => {
    const longUrl = "https://example.com/" + "a".repeat(2048);
    await expect(
      handler({ action: "scrape", payload: { urls: [longUrl] } }),
    ).rejects.toThrow("url exceeds max length");
  });

  it("rejects non-string items in urls array", async () => {
    await expect(
      handler({ action: "scrape", payload: { urls: [123 as any] } }),
    ).rejects.toThrow("must be a string");
  });
});
