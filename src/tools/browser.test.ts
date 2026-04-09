import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _setBrowserPoolForTest, type BrowserPool, type BrowserSession } from "../infra/browser.ts";
import { createBrowserFeedbackTracker } from "../infra/browser-feedback.ts";
import { createBrowserInterventions } from "../infra/browser-interventions.ts";
import { _setSandboxForTest, type FileProvider } from "../infra/sandbox.ts";
import browserTool from "./browser.ts";

// ── Mock helpers ────────────────────────────────────────────────

function createMockPage(opts: {
  title?: string;
  url?: string;
  bodyText?: string;
  evaluateResult?: unknown;
  screenshotBuffer?: Buffer;
} = {}) {
  let currentUrl = opts.url ?? "https://example.com/test";
  const title = opts.title ?? "Test Page";

  return {
    goto: async (_url: string) => {
      currentUrl = _url;
      return { status: () => 200 };
    },
    title: async () => title,
    url: () => currentUrl,
    innerText: async () => opts.bodyText ?? "Hello\nWorld",
    evaluate: async (expr: unknown, arg?: unknown) => {
      // If called from extractDomStructure (function + arg), return empty string
      if (typeof expr === "function") return "";
      if ("evaluateResult" in opts) return opts.evaluateResult;
      return "evaluated";
    },
    click: async (sel: string, _opts?: unknown) => {},
    getByText: (t: string) => ({
      click: async (_opts?: unknown) => {},
    }),
    fill: async (sel: string, val: string, _opts?: unknown) => {},
    press: async (sel: string, key: string) => {},
    screenshot: async (screenshotOpts?: { fullPage?: boolean }) => {
      return opts.screenshotBuffer ?? Buffer.from("fakepng");
    },
    waitForTimeout: async (ms: number) => {},
    isClosed: () => false,
  };
}

function createMockSession(page: ReturnType<typeof createMockPage>): BrowserSession {
  const tracker = createBrowserFeedbackTracker();
  const interventions = createBrowserInterventions(tracker);
  return {
    async getPage() { return page as never; },
    async saveSession() {},
    async close() {},
    isRunning() { return true; },
    feedbackTracker: tracker,
    interventions,
  };
}

function createMockPool(session: BrowserSession): BrowserPool {
  return {
    get() { return session; },
    async close() {},
    async closeAll() {},
    size() { return 1; },
  };
}

function createMockFiles(): FileProvider {
  const storage = new Map<string, string>();
  return {
    async exists(p: string) { return storage.has(p); },
    async readText(p: string) { return storage.get(p) ?? ""; },
    async readBinary(p: string) { return Buffer.from(storage.get(p) ?? ""); },
    async readJson<T>(p: string) { return JSON.parse(storage.get(p) ?? "{}") as T; },
    async write(p: string, data: string | Response) {
      if (data instanceof Response) {
        storage.set(p, await data.text());
      } else {
        storage.set(p, data);
      }
    },
    async append(p: string, data: string) { storage.set(p, (storage.get(p) ?? "") + data); },
    async readdir() { return []; },
    async stat() { return { isFile: true, isDirectory: false, size: 100 }; },
    async mkdir() {},
    async checkFileSize() {},
    async resolveInput(input: string) { return input; },
    _storage: storage,
  } as FileProvider & { _storage: Map<string, string> };
}

// ── Tests ───────────────────────────────────────────────────────

describe("browser tool", () => {
  let restorePool: () => void;
  let restoreFiles: () => void;

  beforeEach(() => {
    const page = createMockPage();
    const session = createMockSession(page);
    restorePool = _setBrowserPoolForTest(createMockPool(session));
    restoreFiles = _setSandboxForTest(createMockFiles());
  });

  afterEach(() => {
    restorePool();
    restoreFiles();
  });

  describe("navigate", () => {
    it("returns page title and URL on success", async () => {
      const result = await browserTool.handler({
        action: "navigate",
        payload: { url: "https://example.com/test" },
      });
      expect(result.isError).toBeUndefined();
      const textContent = result.content.find((c) => c.type === "text");
      expect(textContent).toBeDefined();
      expect((textContent as { text: string }).text).toContain("Title:");
      expect((textContent as { text: string }).text).toContain("Status: ok");
    });

    it("rejects URL that is too long", async () => {
      const longUrl = "https://example.com/" + "a".repeat(2100);
      await expect(
        browserTool.handler({ action: "navigate", payload: { url: longUrl } }),
      ).rejects.toThrow("exceeds max length");
    });

    it("rejects invalid URL", async () => {
      await expect(
        browserTool.handler({ action: "navigate", payload: { url: "not-a-url" } }),
      ).rejects.toThrow();
    });

    it("detects error pages from HTTP status", async () => {
      const page = createMockPage({ bodyText: "Not Found" });
      (page as any).goto = async (url: string) => ({ status: () => 404 });
      const session = createMockSession(page);
      restorePool();
      restorePool = _setBrowserPoolForTest(createMockPool(session));

      const result = await browserTool.handler({
        action: "navigate",
        payload: { url: "https://example.com/missing" },
      });
      const textContent = result.content.find((c) => c.type === "text");
      expect((textContent as { text: string }).text).toContain("Status: error");
    });

    it("detects error pages from body text patterns", async () => {
      const page = createMockPage({ bodyText: "Access Denied — you do not have permission" });
      const session = createMockSession(page);
      restorePool();
      restorePool = _setBrowserPoolForTest(createMockPool(session));

      const result = await browserTool.handler({
        action: "navigate",
        payload: { url: "https://example.com/secret" },
      });
      const textContent = result.content.find((c) => c.type === "text");
      expect((textContent as { text: string }).text).toContain("Status: error");
    });

    it("saves artifacts only to pagesDir (not session output)", async () => {
      const mockFiles = createMockFiles();
      restoreFiles();
      restoreFiles = _setSandboxForTest(mockFiles);

      await browserTool.handler({
        action: "navigate",
        payload: { url: "https://example.com/page" },
      });

      const keys = Array.from((mockFiles as any)._storage.keys());
      // Should have files in pagesDir
      expect(keys.some((k: string) => k.includes("browser/pages/") && k.endsWith(".txt"))).toBe(true);
      expect(keys.some((k: string) => k.includes("browser/pages/") && k.endsWith(".struct.txt"))).toBe(true);
      // Should NOT have session output copies
      expect(keys.some((k: string) => k.includes("sessions/"))).toBe(false);
    });

    it("caps text at configured max lines", async () => {
      const longBody = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}`).join("\n");
      const page = createMockPage({ bodyText: longBody });
      const session = createMockSession(page);
      const mockFiles = createMockFiles();
      restorePool();
      restoreFiles();
      restorePool = _setBrowserPoolForTest(createMockPool(session));
      restoreFiles = _setSandboxForTest(mockFiles);

      await browserTool.handler({
        action: "navigate",
        payload: { url: "https://example.com/long" },
      });

      const keys = Array.from((mockFiles as any)._storage.keys());
      const txtKey = keys.find((k: string) => k.endsWith(".txt") && !k.endsWith(".struct.txt"));
      expect(txtKey).toBeDefined();
      const content = (mockFiles as any)._storage.get(txtKey!);
      const lines = content.split("\n");
      expect(lines.length).toBeLessThanOrEqual(500);
    });

    it("includes instruction file pointer when available", async () => {
      const mockFiles = createMockFiles();
      restoreFiles();
      restoreFiles = _setSandboxForTest(mockFiles);
      const knowledgePath = `${process.cwd()}/workspace/knowledge/browser/example.com.md`;
      (mockFiles as any)._storage.set(knowledgePath, "# Instructions for example.com");

      const result = await browserTool.handler({
        action: "navigate",
        payload: { url: "https://example.com/page" },
      });

      const texts = result.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      expect(texts).toContain("Instruction file found");
    });

    it("returns resource refs for artifacts", async () => {
      const result = await browserTool.handler({
        action: "navigate",
        payload: { url: "https://example.com/page" },
      });
      const resources = result.content.filter((c) => c.type === "resource");
      expect(resources.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("evaluate", () => {
    it("returns evaluated result", async () => {
      const page = createMockPage({ evaluateResult: "hello world" });
      const session = createMockSession(page);
      restorePool();
      restorePool = _setBrowserPoolForTest(createMockPool(session));

      const result = await browserTool.handler({
        action: "evaluate",
        payload: { expression: "document.title" },
      });
      const txt = result.content.find((c) => c.type === "text");
      expect((txt as { text: string }).text).toContain("hello world");
    });

    it("serializes object results as JSON", async () => {
      const page = createMockPage({ evaluateResult: { key: "value" } });
      const session = createMockSession(page);
      restorePool();
      restorePool = _setBrowserPoolForTest(createMockPool(session));

      const result = await browserTool.handler({
        action: "evaluate",
        payload: { expression: "({key: 'value'})" },
      });
      const txt = result.content.find((c) => c.type === "text");
      expect((txt as { text: string }).text).toContain('"key"');
    });

    it("handles undefined result", async () => {
      const page = createMockPage({ evaluateResult: undefined });
      const session = createMockSession(page);
      restorePool();
      restorePool = _setBrowserPoolForTest(createMockPool(session));

      const result = await browserTool.handler({
        action: "evaluate",
        payload: { expression: "void 0" },
      });
      const txt = result.content.find((c) => c.type === "text");
      expect((txt as { text: string }).text).toContain("undefined");
    });

    it("rejects expression exceeding max length", async () => {
      const longExpr = "a".repeat(10_001);
      await expect(
        browserTool.handler({ action: "evaluate", payload: { expression: longExpr } }),
      ).rejects.toThrow("exceeds max length");
    });

    it("truncates long results", async () => {
      const page = createMockPage({ evaluateResult: "x".repeat(6000) });
      const session = createMockSession(page);
      restorePool();
      restorePool = _setBrowserPoolForTest(createMockPool(session));

      const result = await browserTool.handler({
        action: "evaluate",
        payload: { expression: "'x'.repeat(6000)" },
      });
      const txt = result.content.find((c) => c.type === "text");
      expect((txt as { text: string }).text).toContain("truncated");
    });
  });

  describe("click", () => {
    it("clicks by css_selector", async () => {
      const result = await browserTool.handler({
        action: "click",
        payload: { css_selector: "#btn" },
      });
      expect(result.isError).toBeUndefined();
      const txt = result.content.find((c) => c.type === "text");
      expect((txt as { text: string }).text).toContain("Title:");
    });

    it("clicks by text", async () => {
      const result = await browserTool.handler({
        action: "click",
        payload: { text: "Submit" },
      });
      expect(result.isError).toBeUndefined();
    });

    it("rejects when both css_selector and text provided", async () => {
      await expect(
        browserTool.handler({
          action: "click",
          payload: { css_selector: "#btn", text: "Submit" },
        }),
      ).rejects.toThrow("exactly one");
    });

    it("rejects when neither css_selector nor text provided", async () => {
      await expect(
        browserTool.handler({ action: "click", payload: {} }),
      ).rejects.toThrow("exactly one");
    });

    it("rejects selector exceeding max length", async () => {
      await expect(
        browserTool.handler({
          action: "click",
          payload: { css_selector: "a".repeat(501) },
        }),
      ).rejects.toThrow("exceeds max length");
    });
  });

  describe("type_text", () => {
    it("fills input and returns page info", async () => {
      const result = await browserTool.handler({
        action: "type_text",
        payload: { selector: "#email", value: "test@test.com", press_enter: false },
      });
      expect(result.isError).toBeUndefined();
      const txt = result.content.find((c) => c.type === "text");
      expect((txt as { text: string }).text).toContain("Title:");
    });

    it("rejects oversized selector", async () => {
      await expect(
        browserTool.handler({
          action: "type_text",
          payload: { selector: "x".repeat(501), value: "hi", press_enter: false },
        }),
      ).rejects.toThrow("exceeds max length");
    });

    it("rejects oversized value", async () => {
      await expect(
        browserTool.handler({
          action: "type_text",
          payload: { selector: "#input", value: "x".repeat(5001), press_enter: false },
        }),
      ).rejects.toThrow("exceeds max length");
    });
  });

  describe("take_screenshot", () => {
    it("returns ImagePart with base64 data", async () => {
      const result = await browserTool.handler({
        action: "take_screenshot",
        payload: { full_page: false },
      });
      const imagePart = result.content.find((c) => c.type === "image");
      expect(imagePart).toBeDefined();
      expect((imagePart as any).mimeType).toBe("image/png");
      expect((imagePart as any).data).toBeDefined();
    });

    it("falls back to viewport when full_page exceeds size limit", async () => {
      let callCount = 0;
      const page = createMockPage();
      (page as any).screenshot = async (opts?: { fullPage?: boolean }) => {
        callCount++;
        if (callCount === 1 && opts?.fullPage) {
          return Buffer.alloc(1_048_577);
        }
        return Buffer.from("small-png");
      };
      const session = createMockSession(page);
      restorePool();
      restorePool = _setBrowserPoolForTest(createMockPool(session));

      const result = await browserTool.handler({
        action: "take_screenshot",
        payload: { full_page: true },
      });

      const texts = result.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      expect(texts).toContain("Full-page screenshot exceeded 1 MB");
      expect(callCount).toBe(2);
    });

    it("saves screenshot file to session output", async () => {
      const mockFiles = createMockFiles();
      restoreFiles();
      restoreFiles = _setSandboxForTest(mockFiles);

      await browserTool.handler({
        action: "take_screenshot",
        payload: { full_page: false },
      });

      const keys = Array.from((mockFiles as any)._storage.keys());
      expect(keys.some((k: string) => k.endsWith(".png"))).toBe(true);
    });
  });

  describe("feedback integration", () => {
    it("feedback tracker is per-session via BrowserSession", async () => {
      const page = createMockPage();
      const session = createMockSession(page);
      restorePool();
      restorePool = _setBrowserPoolForTest(createMockPool(session));

      // Initial state
      expect(session.feedbackTracker.stats().total).toBe(0);

      await browserTool.handler({
        action: "navigate",
        payload: { url: "https://example.com" },
      });

      // After navigate, tracker should have recorded the event
      expect(session.feedbackTracker.stats().total).toBe(1);
    });
  });

  describe("unknown action", () => {
    it("rejects unknown action", async () => {
      await expect(
        browserTool.handler({ action: "unknown", payload: {} }),
      ).rejects.toThrow("Unknown browser action");
    });
  });
});
