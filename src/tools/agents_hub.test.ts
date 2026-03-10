import { describe, it, expect, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import agentsHub from "./agents_hub.ts";
import { ALLOWED_READ_PATHS } from "../config.ts";

const handler = agentsHub.handler;

let tmp: string;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agents-hub-test-"));
  ALLOWED_READ_PATHS.push(tmp);
  process.env.HUB_API_KEY = "test-key-123";
});

afterAll(async () => {
  ALLOWED_READ_PATHS.splice(ALLOWED_READ_PATHS.indexOf(tmp), 1);
  await rm(tmp, { recursive: true, force: true });
  delete process.env.HUB_API_KEY;
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

describe("agents_hub api_request", () => {
  it("sends inline body with apikey merged", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ message: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = (await handler({
      action: "api_request",
      payload: { path: "location", body: { query: "test" } },
    })) as any;

    expect(capturedUrl).toBe("https://hub.ag3nts.org/api/location");
    expect(capturedBody.query).toBe("test");
    expect(capturedBody.apikey).toBe("test-key-123");
    expect(result.path).toBe("location");
    expect(result.response).toEqual({ message: "ok" });
  });

  it("reads body from file with apikey merged", async () => {
    const bodyFile = join(tmp, "request.json");
    await Bun.write(bodyFile, JSON.stringify({ query: "from-file", limit: 5 }));

    let capturedBody: any = null;

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ data: [1, 2] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = (await handler({
      action: "api_request",
      payload: { path: "search", body_file: bodyFile },
    })) as any;

    expect(capturedBody.query).toBe("from-file");
    expect(capturedBody.limit).toBe(5);
    expect(capturedBody.apikey).toBe("test-key-123");
    expect(result.response).toEqual({ data: [1, 2] });
  });

  it("throws when both body and body_file are provided", async () => {
    await expect(
      handler({
        action: "api_request",
        payload: { path: "test", body: { x: 1 }, body_file: "/some/file.json" },
      }),
    ).rejects.toThrow("Provide either body or body_file, not both");
  });

  it("throws when neither body nor body_file is provided", async () => {
    await expect(
      handler({
        action: "api_request",
        payload: { path: "test" },
      }),
    ).rejects.toThrow("Provide either body or body_file");
  });

  it("throws on non-OK HTTP response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as any;

    await expect(
      handler({
        action: "api_request",
        payload: { path: "missing", body: {} },
      }),
    ).rejects.toThrow("API request failed: 404 Not Found");
  });

  it("returns text response when content-type is not JSON", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("plain text response", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as any;

    const result = (await handler({
      action: "api_request",
      payload: { path: "echo", body: { msg: "hi" } },
    })) as any;

    expect(result.response).toBe("plain text response");
  });
});
