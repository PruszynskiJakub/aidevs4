import { describe, it, expect, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Document } from "../types/document.ts";
import web from "./web.ts";
import { config } from "../config/index.ts";
import { createBunFileService, _setFilesForTest } from "../services/common/file.ts";

const handler = web.handler;

let tmp: string;
let restoreFiles: () => void;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "web-test-"));
  restoreFiles = _setFilesForTest(
    createBunFileService(
      [...config.sandbox.allowedReadPaths, tmp],
      [...config.sandbox.allowedWritePaths, tmp],
    ),
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
  it("resolves placeholders, fetches, and writes file", async () => {
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
    }) as Document;

    expect(capturedUrl).toBe(`https://hub.ag3nts.org/data/${config.hub.apiKey}/people.csv`);
    expect(result.text).toContain("File saved to");
    expect(result.text).toContain("people.csv");
    expect(result.description).toContain("Web download from");
    expect(result.metadata.source).toContain("people.csv");
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
    }) as Document;

    expect(capturedUrl).toBe("https://centrala.ag3nts.org/files/report.txt");
    expect(result.text).toContain("File saved to");
  });

  it("throws on unknown placeholder", async () => {
    await expect(
      handler({
        action: "download",
        payload: {
          url: "https://hub.ag3nts.org/data/{{unknown_key}}/file.txt",
          filename: "file.txt",
        },
      }),
    ).rejects.toThrow('Unknown placeholder "{{unknown_key}}"');
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
  it("scrapes a single URL and returns Document[]", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ text: "Hello from page" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const results = (await handler({
      action: "scrape",
      payload: { urls: ["https://example.com/page"] },
    })) as Document[];

    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("Hello from page");
    expect(results[0].description).toContain("https://example.com/page");
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

    const results = (await handler({
      action: "scrape",
      payload: { urls: ["https://a.com", "https://b.com", "https://c.com"] },
    })) as Document[];

    expect(results).toHaveLength(3);
    expect(callCount).toBe(3);
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

    const results = (await handler({
      action: "scrape",
      payload: { urls: ["https://good.com", "https://bad.com"] },
    })) as Document[];

    expect(results).toHaveLength(2);
    expect(results[0].text).toBe("OK");
    expect(results[1].text).toContain("Error scraping");
    expect(results[1].text).toContain("404");
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

  it("falls back to JSON.stringify when no text field in response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ custom: "data", nested: { a: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const results = (await handler({
      action: "scrape",
      payload: { urls: ["https://example.com"] },
    })) as Document[];

    expect(results[0].text).toContain("custom");
    expect(results[0].text).toContain("data");
  });
});
