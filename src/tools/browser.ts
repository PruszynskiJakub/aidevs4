import { z } from "zod";
import { createHash } from "crypto";
import { join } from "path";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import type { ContentPart } from "../types/llm.ts";
import { text, resource } from "../types/tool-result.ts";
import { files } from "../infra/file.ts";
import { browserPool, type BrowserSession } from "../infra/browser.ts";
import { sessionService } from "../agent/session.ts";
import { config } from "../config/index.ts";
import { assertMaxLength, errorMessage } from "../utils/parse.ts";

// ── Helpers ─────────────────────────────────────────────────────

function getSession(): BrowserSession {
  return browserPool.get();
}

function urlSlug(urlStr: string): string {
  const parsed = new URL(urlStr);
  const base = (parsed.hostname + parsed.pathname)
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  const hash = createHash("md5").update(urlStr).digest("hex").slice(0, 6);
  return `${base}-${hash}`;
}

function extractNumberedText(bodyText: string, maxLines: number): string {
  const lines = bodyText.split("\n").slice(0, maxLines);
  return lines.map((line, i) => `${i + 1}: ${line}`).join("\n");
}

async function extractDomStructure(page: import("playwright").Page): Promise<string> {
  const maxNodes = config.browser.structMaxNodes;
  const maxDepth = config.browser.structMaxDepth;

  return page.evaluate(
    ({ maxNodes: mn, maxDepth: md }) => {
      let nodeCount = 0;
      const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT"]);
      const KEY_ATTRS = ["name", "type", "href", "role", "aria-label", "data-testid"];

      function walk(el: Element, depth: number): string {
        if (nodeCount >= mn || depth > md) return "";
        if (SKIP_TAGS.has(el.tagName)) return "";
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return "";

        nodeCount++;
        const indent = "  ".repeat(depth);
        let tag = el.tagName.toLowerCase();

        if (el.id) tag += `#${el.id}`;
        const classes = Array.from(el.classList).slice(0, 2);
        if (classes.length) tag += classes.map((c) => `.${c}`).join("");

        const attrs = KEY_ATTRS
          .filter((a) => el.hasAttribute(a))
          .map((a) => `[${a}="${el.getAttribute(a)}"]`)
          .join("");
        tag += attrs;

        let leafText = "";
        if (el.children.length === 0 && el.textContent) {
          const t = el.textContent.trim().slice(0, 50);
          if (t) leafText = ` "${t}"`;
        }

        let result = `${indent}${tag}${leafText}\n`;

        for (const child of el.children) {
          if (nodeCount >= mn) break;
          result += walk(child, depth + 1);
        }
        return result;
      }

      const body = document.querySelector("body");
      return body ? walk(body, 0) : "";
    },
    { maxNodes, maxDepth },
  );
}

async function savePageArtifacts(
  page: import("playwright").Page,
  urlStr: string,
  bodyText: string,
): Promise<{ textPath: string; structPath: string; lineCount: number }> {
  const slug = urlSlug(urlStr);
  const numbered = extractNumberedText(bodyText, config.browser.textMaxLines);

  const pagesDir = config.browser.pagesDir;
  const [struct] = await Promise.all([
    extractDomStructure(page),
    files.mkdir(pagesDir),
  ]);

  const textPath = join(pagesDir, `${slug}.txt`);
  const structPath = join(pagesDir, `${slug}.struct.txt`);

  await Promise.all([
    files.write(textPath, numbered),
    files.write(structPath, struct),
  ]);

  return { textPath, structPath, lineCount: numbered.split("\n").length };
}

const ERROR_PATTERNS = [
  /\b404\b/i,
  /not found/i,
  /access denied/i,
  /forbidden/i,
  /\bsorry\b/i,
  /page not found/i,
  /unauthorized/i,
];

function detectErrorPage(httpStatus: number | null, bodyText: string): boolean {
  if (httpStatus && httpStatus >= 400) return true;
  const sample = bodyText.slice(0, 2000).toLowerCase();
  return ERROR_PATTERNS.some((p) => p.test(sample));
}

function appendFeedback(
  parts: string[],
  session: BrowserSession,
  tool: string,
  outcome: "success" | "fail",
  error?: string,
): void {
  session.feedbackTracker.record({ tool, outcome, args: {}, error });

  const hints = session.feedbackTracker.generateHints(tool, outcome, error);
  for (const hint of hints) {
    parts.push(`Note: ${hint}`);
  }

  const screenshotHint = session.interventions.checkScreenshotHint();
  if (screenshotHint) parts.push(`Note: ${screenshotHint}`);

  const discoveryHint = session.interventions.checkDiscoveryHint(outcome);
  if (discoveryHint) parts.push(`Note: ${discoveryHint}`);
}

/** Shared post-action logic for click/typeText: detect navigation, save artifacts, build response. */
async function handlePostAction(
  session: BrowserSession,
  page: import("playwright").Page,
  urlBefore: string,
  toolName: string,
): Promise<ToolResult> {
  const urlAfter = page.url();
  if (urlAfter !== urlBefore) {
    const bodyText = await page.innerText("body").catch(() => "");
    await session.saveSession();
    await savePageArtifacts(page, urlAfter, bodyText);
  }

  const title = await page.title();
  const parts = [`Title: ${title}`, `URL: ${urlAfter}`];
  if (urlAfter !== urlBefore) {
    parts.push("Page navigated to a new URL — new artifacts saved.");
  }
  appendFeedback(parts, session, toolName, "success");
  return text(parts.join("\n"));
}

// ── Actions ─────────────────────────────────────────────────────

async function navigate(payload: { url: string }): Promise<ToolResult> {
  assertMaxLength(payload.url, "url", 2048);

  const parsed = new URL(payload.url);
  const session = getSession();
  const page = await session.getPage();

  const response = await page.goto(payload.url, {
    waitUntil: "domcontentloaded",
    timeout: config.browser.timeouts.navigation,
  });

  const httpStatus = response?.status() ?? null;

  await page.waitForTimeout(config.browser.timeouts.settleAfterNavigation);
  await session.saveSession();

  const bodyText = await page.innerText("body").catch(() => "");
  const { textPath, structPath, lineCount } = await savePageArtifacts(page, payload.url, bodyText);

  const title = await page.title();
  const currentUrl = page.url();
  const isError = detectErrorPage(httpStatus, bodyText);

  const content: ContentPart[] = [
    {
      type: "text",
      text: [
        `Title: ${title}`,
        `URL: ${currentUrl}`,
        `Status: ${isError ? "error" : "ok"}${httpStatus ? ` (HTTP ${httpStatus})` : ""}`,
        `Lines: ${lineCount}`,
      ].join("\n"),
    },
    resource(`file://${textPath}`, `Page text: ${title}`, "text/plain"),
    resource(`file://${structPath}`, `DOM structure: ${title}`, "text/plain"),
  ];

  const knowledgePath = join("workspace", "knowledge", "browser", `${parsed.hostname}.md`);
  const fullKnowledgePath = join(config.paths.projectRoot, knowledgePath);
  if (await files.exists(fullKnowledgePath)) {
    content.push({
      type: "text",
      text: `\nNote: Instruction file found at ${knowledgePath} — read it for known patterns and recipes.`,
    });
  }

  const feedbackParts: string[] = [];
  appendFeedback(feedbackParts, session, "browser__navigate", isError ? "fail" : "success", isError ? `Error page: HTTP ${httpStatus}` : undefined);
  if (feedbackParts.length > 0) {
    content.push({ type: "text", text: feedbackParts.join("\n") });
  }

  if (!isError) {
    content.push({ type: "text", text: "\nNote: Search the .struct.txt file to find CSS selectors, then extract data via JavaScript evaluation." });
  }

  return { content };
}

async function evaluate(payload: { expression: string }): Promise<ToolResult> {
  assertMaxLength(payload.expression, "expression", 10_000);

  const session = getSession();
  const page = await session.getPage();
  let result: unknown;
  try {
    const evaluateTimeout = config.browser.timeouts.evaluate;
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Evaluate timed out after ${evaluateTimeout}ms`)), evaluateTimeout);
    });
    try {
      result = await Promise.race([page.evaluate(payload.expression), timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  } catch (err) {
    const msg = errorMessage(err);
    const parts = [`Evaluate error: ${msg}`];
    appendFeedback(parts, session, "browser__evaluate", "fail", msg);
    throw new Error(parts.join("\n"));
  }

  let serialized: string;
  if (result === undefined) {
    serialized = "undefined";
  } else if (typeof result === "string") {
    serialized = result;
  } else {
    serialized = JSON.stringify(result, null, 2);
  }

  const MAX_RESULT = 5000;
  let output = serialized;
  if (serialized.length > MAX_RESULT) {
    output = serialized.slice(0, MAX_RESULT) + `\n... (truncated, full length: ${serialized.length} chars)`;
  }

  const parts = [output];
  appendFeedback(parts, session, "browser__evaluate", "success");
  return text(parts.join("\n"));
}

async function click(payload: { css_selector?: string; text?: string }): Promise<ToolResult> {
  const hasCss = payload.css_selector !== undefined && payload.css_selector !== "";
  const hasText = payload.text !== undefined && payload.text !== "";

  if (hasCss && hasText) {
    throw new Error("Provide exactly one of css_selector or text, not both");
  }
  if (!hasCss && !hasText) {
    throw new Error("Provide exactly one of css_selector or text");
  }

  if (hasCss) assertMaxLength(payload.css_selector!, "css_selector", 500);
  if (hasText) assertMaxLength(payload.text!, "text", 500);

  const session = getSession();
  const page = await session.getPage();
  const urlBefore = page.url();

  try {
    if (hasText) {
      await page.getByText(payload.text!).click({ timeout: config.browser.timeouts.action });
    } else {
      await page.click(payload.css_selector!, { timeout: config.browser.timeouts.action });
    }
  } catch (err) {
    const msg = errorMessage(err);
    const parts = [`Click failed: ${msg}`];
    appendFeedback(parts, session, "browser__click", "fail", msg);
    throw new Error(parts.join("\n"));
  }

  await page.waitForTimeout(config.browser.timeouts.settleAfterClick);
  return handlePostAction(session, page, urlBefore, "browser__click");
}

function resolveValuePlaceholders(value: string): string {
  return value.replace(/\{\{hub_api_key\}\}/g, config.hub.apiKey);
}

async function typeText(payload: { selector: string; value: string; press_enter: boolean }): Promise<ToolResult> {
  assertMaxLength(payload.selector, "selector", 500);
  assertMaxLength(payload.value, "value", 5000);

  const resolvedValue = resolveValuePlaceholders(payload.value);

  const session = getSession();
  const page = await session.getPage();
  const urlBefore = page.url();

  try {
    await page.fill(payload.selector, resolvedValue, { timeout: config.browser.timeouts.action });
    if (payload.press_enter) {
      await page.press(payload.selector, "Enter");
    }
  } catch (err) {
    const msg = errorMessage(err);
    const parts = [`Type failed: ${msg}`];
    appendFeedback(parts, session, "browser__type_text", "fail", msg);
    throw new Error(parts.join("\n"));
  }

  await page.waitForTimeout(config.browser.timeouts.settleAfterType);
  return handlePostAction(session, page, urlBefore, "browser__type_text");
}

async function takeScreenshot(payload: { full_page: boolean }): Promise<ToolResult> {
  const session = getSession();
  const page = await session.getPage();

  let buffer = await page.screenshot({
    fullPage: payload.full_page,
    type: "png",
    timeout: config.browser.timeouts.screenshot,
  });

  let fallbackNote = "";
  if (buffer.byteLength > config.browser.screenshotMaxBytes && payload.full_page) {
    buffer = await page.screenshot({
      fullPage: false,
      type: "png",
      timeout: config.browser.timeouts.screenshot,
    });
    fallbackNote = "\nNote: Full-page screenshot exceeded 1 MB — viewport-only screenshot returned instead.";
  }

  const path = await sessionService.outputPath("screenshot.png");
  await files.write(path, new Response(buffer));

  const relativePath = sessionService.toSessionPath(path);
  const base64 = Buffer.from(buffer).toString("base64");

  const content: ContentPart[] = [
    { type: "image", data: base64, mimeType: "image/png" },
    { type: "text", text: `Screenshot saved to ${relativePath}.${fallbackNote}` },
  ];

  const parts: string[] = [];
  appendFeedback(parts, session, "browser__take_screenshot", "success");
  if (parts.length > 0) {
    content.push({ type: "text", text: parts.join("\n") });
  }

  return { content };
}

// ── Handler dispatch ────────────────────────────────────────────

async function browserHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
  switch (action) {
    case "navigate":
      return navigate(payload as { url: string });
    case "evaluate":
      return evaluate(payload as { expression: string });
    case "click":
      return click(payload as { css_selector?: string; text?: string });
    case "type_text":
      return typeText(payload as { selector: string; value: string; press_enter: boolean });
    case "take_screenshot":
      return takeScreenshot(payload as { full_page: boolean });
    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
}

// ── Tool definition ─────────────────────────────────────────────

export default {
  name: "browser",
  schema: {
    name: "browser",
    description: "Interact with web pages using a real browser. Supports navigation, JavaScript evaluation, clicking elements, filling forms, and taking screenshots. Browser session (cookies, localStorage) persists across calls.",
    actions: {
      navigate: {
        description: "Load a URL in the browser. Returns page title, URL, status, and saves page text + DOM structure artifacts. Check the .struct.txt artifact to find CSS selectors for subsequent evaluate or click actions.",
        schema: z.object({
          url: z.string().describe("Full URL to navigate to (e.g. https://example.com/page)"),
        }),
      },
      evaluate: {
        description: "Execute a JavaScript expression in the page context and return the result. Preferred way to extract data — returns only what the expression produces. Use CSS selectors from .struct.txt files.",
        schema: z.object({
          expression: z.string().describe("JavaScript expression to evaluate in the page (max 10,000 chars). Must return a serializable value."),
        }),
      },
      click: {
        description: "Click an element on the page. Provide exactly one of css_selector or text (set the other to empty string). If the click causes navigation, new page artifacts are saved automatically.",
        schema: z.object({
          css_selector: z.string().describe("CSS selector of the element to click. Set to empty string if using text instead."),
          text: z.string().describe("Visible text of the element to click (uses getByText matching). Set to empty string if using css_selector instead."),
        }),
      },
      type_text: {
        description: "Fill an input field with text. Optionally press Enter to submit. If the action causes navigation, new page artifacts are saved automatically.",
        schema: z.object({
          selector: z.string().describe("CSS selector of the input field to fill"),
          value: z.string().describe("Text value to type into the field"),
          press_enter: z.boolean().describe("Whether to press Enter after typing"),
        }),
      },
      take_screenshot: {
        description: "Take a PNG screenshot of the current page. Returns the image for visual inspection. Useful when page interactions produce unexpected results.",
        schema: z.object({
          full_page: z.boolean().describe("Whether to capture the full scrollable page (true) or just the viewport (false). Full-page falls back to viewport if result exceeds 1 MB."),
        }),
      },
    },
  },
  handler: browserHandler,
} satisfies ToolDefinition;
