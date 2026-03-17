import { describe, it, expect, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import web from "./web.ts";
import { config } from "../config/index.ts";
import { _testWritePaths } from "../services/file.ts";

const handler = web.handler;

let tmp: string;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "web-test-"));
  _testWritePaths.push(tmp);
});

afterAll(async () => {
  _testWritePaths.splice(_testWritePaths.indexOf(tmp), 1);
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

    const result = (await handler({
      action: "download",
      payload: {
        url: "https://hub.ag3nts.org/data/{{hub_api_key}}/people.csv",
        filename: "people.csv",
      },
    })) as any;

    expect(capturedUrl).toBe(`https://hub.ag3nts.org/data/${config.hub.apiKey}/people.csv`);
    expect(result.status).toBe("ok");
    expect(result.data.filename).toBe("people.csv");
    expect(result.data.path).toContain("people.csv");
    expect(result.hints?.length).toBeGreaterThan(0);
  });

  it("downloads without placeholders", async () => {
    let capturedUrl = "";

    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response("data", { status: 200 });
    }) as any;

    const result = (await handler({
      action: "download",
      payload: {
        url: "https://centrala.ag3nts.org/files/report.txt",
        filename: "report.txt",
      },
    })) as any;

    expect(capturedUrl).toBe("https://centrala.ag3nts.org/files/report.txt");
    expect(result.status).toBe("ok");
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
