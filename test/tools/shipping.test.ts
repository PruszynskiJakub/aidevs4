import { describe, it, expect, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import type { ToolResult } from "../../src/types/tool-result.ts";
import { config } from "../../src/config/index.ts";
import shipping from "../../src/tools/shipping.ts";

const handler = shipping.handler;

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

const originalFetch = globalThis.fetch;

beforeAll(() => {
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

describe("shipping check", () => {
  it("sends correct body and returns package status", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ status: "in_transit", location: "Warsaw" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({ action: "check", payload: { packageid: "PKG123" } });

    expect(capturedUrl).toBe("https://hub.ag3nts.org/api/packages");
    expect(capturedBody.apikey).toBe(config.hub.apiKey);
    expect(capturedBody.action).toBe("check");
    expect(capturedBody.packageid).toBe("PKG123");
    expect(getText(result)).toContain("in_transit");
  });
});

describe("shipping redirect", () => {
  it("sends correct body with all fields and returns confirmation", async () => {
    let capturedBody: any = null;

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ confirmed: true, destination: "PWR6132PL", confirmation: "abc123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({
      action: "redirect",
      payload: { packageid: "PKG456", destination: "PWR6132PL", code: "SEC001" },
    });

    expect(capturedBody.apikey).toBe(config.hub.apiKey);
    expect(capturedBody.action).toBe("redirect");
    expect(capturedBody.packageid).toBe("PKG456");
    expect(capturedBody.destination).toBe("PWR6132PL");
    expect(capturedBody.code).toBe("SEC001");
    expect(getText(result)).toContain("abc123");
    expect(getText(result)).toContain("PKG456");
    expect(getText(result)).toContain("Confirmation code: abc123");
  });
});

describe("shipping input validation", () => {
  it("rejects packageid that is too long", async () => {
    await expect(
      handler({ action: "check", payload: { packageid: "A".repeat(21) } }),
    ).rejects.toThrow("packageid exceeds max length of 20");
  });

  it("rejects packageid with invalid characters", async () => {
    await expect(
      handler({ action: "check", payload: { packageid: "../etc/passwd" } }),
    ).rejects.toThrow("packageid contains invalid characters");
  });

  it("rejects packageid with spaces", async () => {
    await expect(
      handler({ action: "check", payload: { packageid: "PKG 123" } }),
    ).rejects.toThrow("packageid contains invalid characters");
  });

  it("rejects destination with invalid characters", async () => {
    await expect(
      handler({
        action: "redirect",
        payload: { packageid: "PKG1", destination: "BAD!DEST", code: "SEC1" },
      }),
    ).rejects.toThrow("destination contains invalid characters");
  });

  it("rejects destination that is too long", async () => {
    await expect(
      handler({
        action: "redirect",
        payload: { packageid: "PKG1", destination: "D".repeat(21), code: "SEC1" },
      }),
    ).rejects.toThrow("destination exceeds max length of 20");
  });

  it("rejects code that is too long", async () => {
    await expect(
      handler({
        action: "redirect",
        payload: { packageid: "PKG1", destination: "DEST1", code: "C".repeat(101) },
      }),
    ).rejects.toThrow("code exceeds max length of 100");
  });
});

describe("shipping API error handling", () => {
  it("throws on non-200 response for check", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as any;

    try {
      await handler({ action: "check", payload: { packageid: "PKG999" } });
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toBe("Package check failed (404)");
      expect(e.internalMessage).toContain("Not Found");
      expect(e.type).toBe("provider");
    }
  });

  it("throws on non-200 response for redirect", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await expect(
      handler({
        action: "redirect",
        payload: { packageid: "PKG1", destination: "DEST1", code: "BAD" },
      }),
    ).rejects.toThrow('Package redirect failed (403)');
  });
});

describe("shipping unknown action", () => {
  it("throws on unknown action", async () => {
    await expect(
      handler({ action: "delete", payload: { packageid: "PKG1" } }),
    ).rejects.toThrow("Unknown shipping action: delete");
  });
});
