import { describe, it, expect, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

describe("browser integration", () => {
  let browserInstance: Browser;
  let page: Page;

  afterAll(async () => {
    if (browserInstance) await browserInstance.close();
  });

  it("launches headless Chromium, navigates, evaluates, and screenshots", async () => {
    browserInstance = await chromium.launch({ headless: true });
    const context = await browserInstance.newContext();
    page = await context.newPage();

    // Set content as a local HTML page
    await page.setContent(`
      <html>
        <head><title>Integration Test</title></head>
        <body>
          <h1 id="heading">Hello Browser</h1>
          <p class="content">This is a test page.</p>
          <form>
            <input id="search" type="text" name="q" />
            <button type="submit">Search</button>
          </form>
        </body>
      </html>
    `);

    // Verify title
    const title = await page.title();
    expect(title).toBe("Integration Test");

    // Evaluate JS
    const heading = await page.evaluate(() => document.querySelector("#heading")?.textContent);
    expect(heading).toBe("Hello Browser");

    // Extract DOM structure info
    const struct = await page.evaluate(() => {
      const body = document.querySelector("body");
      if (!body) return "";
      let result = "";
      function walk(el: Element, depth: number) {
        const indent = "  ".repeat(depth);
        let tag = el.tagName.toLowerCase();
        if (el.id) tag += `#${el.id}`;
        result += `${indent}${tag}\n`;
        for (const child of el.children) walk(child, depth + 1);
      }
      walk(body, 0);
      return result;
    });
    expect(struct).toContain("h1#heading");
    expect(struct).toContain("input#search");

    // Take screenshot
    const buffer = await page.screenshot({ type: "png" });
    expect(buffer.byteLength).toBeGreaterThan(0);

    // Verify body text extraction
    const bodyText = await page.innerText("body");
    expect(bodyText).toContain("Hello Browser");
    expect(bodyText).toContain("This is a test page.");

    // Verify struct caps work with depth limit
    const deepHtml = "<div>" + "<div>".repeat(20) + "deep" + "</div>".repeat(20) + "</div>";
    await page.setContent(`<html><body>${deepHtml}</body></html>`);
    const deepStruct = await page.evaluate(({ maxDepth }) => {
      let nodeCount = 0;
      function walk(el: Element, depth: number): string {
        if (depth > maxDepth) return "";
        nodeCount++;
        const indent = "  ".repeat(depth);
        let tag = el.tagName.toLowerCase();
        let result = `${indent}${tag}\n`;
        for (const child of el.children) {
          result += walk(child, depth + 1);
        }
        return result;
      }
      const body = document.querySelector("body");
      return body ? walk(body, 0) : "";
    }, { maxDepth: 8 });

    // Should be capped at depth 8
    const lines = deepStruct.split("\n").filter(Boolean);
    const maxIndent = Math.max(...lines.map(l => l.match(/^(\s*)/)?.[1].length ?? 0));
    expect(maxIndent).toBeLessThanOrEqual(8 * 2); // 2 spaces per level
  }, 30_000);
});
