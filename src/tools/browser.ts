import { z } from "zod";
import { createHash } from "crypto";
import { join } from "path";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import type { ContentPart } from "../types/llm.ts";
import { text, resource } from "../types/tool-result.ts";
import { files } from "../infra/file.ts";
import { browser } from "../infra/browser.ts";
import { sessionService } from "../agent/session.ts";
import { config } from "../config/index.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { createBrowserFeedbackTracker } from "../infra/browser-feedback.ts";
import { createBrowserInterventions } from "../infra/browser-interventions.ts";

// ── Per-session feedback & interventions ────────────────────────
const feedbackTracker = createBrowserFeedbackTracker();
const interventions = createBrowserInterventions(feedbackTracker);

// ── Helpers ─────────────────────────────────────────────────────

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
        // Skip hidden elements
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

        // Leaf text
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
): Promise<{ textPath: string; structPath: string; lineCount: number }> {
  const slug = urlSlug(urlStr);

  // Extract text
  const bodyText = await page.innerText("body").catch(() => "");
  const numbered = extractNumberedText(bodyText, config.browser.textMaxLines);
  const lineCount = numbered.split("\n").length;

  // Extract structure
  const struct = await extractDomStructure(page);

  // Save to session output
  const sessionTextPath = await sessionService.outputPath(`${slug}.txt`);
  const sessionStructPath = await sessionService.outputPath(`${slug}.struct.txt`);
  await files.write(sessionTextPath, numbered);
  await files.write(sessionStructPath, struct);

  // Save to workspace/browser/pages/
  const pagesDir = config.browser.pagesDir;
  await files.mkdir(pagesDir);
  const pagesTextPath = join(pagesDir, `${slug}.txt`);
  const pagesStructPath = join(pagesDir, `${slug}.struct.txt`);
  await files.write(pagesTextPath, numbered);
  await files.write(pagesStructPath, struct);

  return { textPath: pagesTextPath, structPath: pagesStructPath, lineCount };
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

function appendFeedback(parts: string[], tool: string, outcome: "success" | "fail", error?: string): void {
  // Record outcome
  feedbackTracker.record({ tool, outcome, args: {}, error });

  // Generate hints
  const hints = feedbackTracker.generateHints(tool, outcome, error);
  for (const hint of hints) {
    parts.push(`Note: ${hint}`);
  }

  // Check interventions
  const screenshotHint = interventions.checkScreenshotHint();
  if (screenshotHint) parts.push(`Note: ${screenshotHint}`);

  const discoveryHint = interventions.checkDiscoveryHint(outcome);
  if (discoveryHint) parts.push(`Note: ${discoveryHint}`);
}

// ── Actions ─────────────────────────────────────────────────────

async function navigate(payload: { url: string }): Promise<ToolResult> {
  assertMaxLength(payload.url, "url", 2048);

  let parsed: URL;
  try {
    parsed = new URL(payload.url);
  } catch {
    throw new Error("Invalid URL format");
  }

  const page = await browser.getPage();

  const response = await page.goto(payload.url, {
    waitUntil: "domcontentloaded",
    timeout: config.browser.timeouts.navigation,
  });

  const httpStatus = response?.status() ?? null;
  browser.setResponseStatus(httpStatus);

  // Wait for JS rendering
  await page.waitForTimeout(config.browser.timeouts.settleAfterNavigation);

  // Save session
  await browser.saveSession();

  // Save artifacts
  const { textPath, structPath, lineCount } = await savePageArtifacts(page, payload.url);

  const title = await page.title();
  const currentUrl = page.url();
  const bodyText = await page.innerText("body").catch(() => "");
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

  // Check for instruction file
  const knowledgePath = join("workspace", "knowledge", "browser", `${parsed.hostname}.md`);
  const fullKnowledgePath = join(config.paths.projectRoot, knowledgePath);
  if (await files.exists(fullKnowledgePath)) {
    content.push({
      type: "text",
      text: `\nNote: Instruction file found at ${knowledgePath} — read it for known patterns and recipes.`,
    });
  }

  // Feedback
  const feedbackParts: string[] = [];
  appendFeedback(feedbackParts, "browser__navigate", isError ? "fail" : "success", isError ? `Error page: HTTP ${httpStatus}` : undefined);
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

  const page = await browser.getPage();
  let result: unknown;
  try {
    const evaluateTimeout = config.browser.timeouts.evaluate;
    result = await Promise.race([
      page.evaluate(payload.expression),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Evaluate timed out after ${evaluateTimeout}ms`)), evaluateTimeout),
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const parts = [`Evaluate error: ${msg}`];
    appendFeedback(parts, "browser__evaluate", "fail", msg);
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
  appendFeedback(parts, "browser__evaluate", "success");
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

  const page = await browser.getPage();
  const urlBefore = page.url();

  try {
    if (hasText) {
      await page.getByText(payload.text!).click({ timeout: config.browser.timeouts.action });
    } else {
      await page.click(payload.css_selector!, { timeout: config.browser.timeouts.action });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const parts = [`Click failed: ${msg}`];
    appendFeedback(parts, "browser__click", "fail", msg);
    throw new Error(parts.join("\n"));
  }

  // Wait for settling
  await page.waitForTimeout(config.browser.timeouts.settleAfterClick);

  const urlAfter = page.url();
  if (urlAfter !== urlBefore) {
    await browser.saveSession();
    await savePageArtifacts(page, urlAfter);
  }

  const title = await page.title();
  const parts = [`Title: ${title}`, `URL: ${urlAfter}`];
  if (urlAfter !== urlBefore) {
    parts.push("Page navigated to a new URL — new artifacts saved.");
  }
  appendFeedback(parts, "browser__click", "success");
  return text(parts.join("\n"));
}

async function typeText(payload: { selector: string; value: string; press_enter: boolean }): Promise<ToolResult> {
  assertMaxLength(payload.selector, "selector", 500);
  assertMaxLength(payload.value, "value", 5000);

  const page = await browser.getPage();
  const urlBefore = page.url();

  try {
    await page.fill(payload.selector, payload.value, { timeout: config.browser.timeouts.action });
    if (payload.press_enter) {
      await page.press(payload.selector, "Enter");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const parts = [`Type failed: ${msg}`];
    appendFeedback(parts, "browser__type_text", "fail", msg);
    throw new Error(parts.join("\n"));
  }

  // Wait for settling
  await page.waitForTimeout(config.browser.timeouts.settleAfterType);

  const urlAfter = page.url();
  if (urlAfter !== urlBefore) {
    await browser.saveSession();
    await savePageArtifacts(page, urlAfter);
  }

  const title = await page.title();
  const parts = [`Title: ${title}`, `URL: ${urlAfter}`];
  if (urlAfter !== urlBefore) {
    parts.push("Page navigated to a new URL — new artifacts saved.");
  }
  appendFeedback(parts, "browser__type_text", "success");
  return text(parts.join("\n"));
}

async function takeScreenshot(payload: { full_page: boolean }): Promise<ToolResult> {
  const page = await browser.getPage();

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
  appendFeedback(parts, "browser__take_screenshot", "success");
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
        description: "Click an element on the page. Provide exactly one of css_selector or text. If the click causes navigation, new page artifacts are saved automatically.",
        schema: z.object({
          css_selector: z.string().describe("CSS selector of the element to click").optional(),
          text: z.string().describe("Visible text of the element to click (uses getByText matching)").optional(),
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
