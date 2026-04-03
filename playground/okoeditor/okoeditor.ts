import { chromium } from "playwright";

const BASE_URL = "https://oko.ag3nts.org";
const API_URL = "https://hub.ag3nts.org/verify";
const API_KEY = process.env.OKO_API_KEY!;

async function apiCall(answer: Record<string, unknown>) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: API_KEY, task: "okoeditor", answer }),
  });
  return res.json();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  });
  const page = await context.newPage();

  // Login
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const inputs = await page.$$("input.field-input");
  await inputs[0].fill("Zofia");
  await inputs[1].fill("Zofia2026!");
  await inputs[2].fill(API_KEY);
  await page.click("button.submit-button");
  await page.waitForTimeout(3000);

  // Get Skolwin incident detail
  console.log("=== Skolwin incident detail ===");
  await page.click('a[href="/incydenty/380792b2c86d9c5be670b3bde48e187b"]');
  await page.waitForTimeout(2000);
  let bodyText = await page.innerText("body").catch(() => "");
  console.log(bodyText.slice(0, 3000));

  // Navigate to zadania
  console.log("\n=== Zadania ===");
  await page.click('a[href="/zadania"]');
  await page.waitForTimeout(2000);
  bodyText = await page.innerText("body").catch(() => "");
  console.log(bodyText.slice(0, 3000));

  // Get full structure of zadania
  const zadaniaStruct = await page.evaluate(() => {
    function walk(el: Element, depth: number): string {
      if (depth > 8) return "";
      const skip = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT"]);
      if (skip.has(el.tagName)) return "";
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls = Array.from(el.classList).slice(0, 3).map(c => `.${c}`).join("");
      const href = el.getAttribute("href") ? `[href="${el.getAttribute("href")}"]` : "";
      const leafText = el.children.length === 0 && el.textContent?.trim() ? ` "${el.textContent.trim().slice(0, 120)}"` : "";
      const indent = "  ".repeat(depth);
      let result = `${indent}${tag}${id}${cls}${href}${leafText}\n`;
      for (const child of el.children) {
        result += walk(child, depth + 1);
      }
      return result;
    }
    return walk(document.body, 0);
  });
  console.log("\nZadania structure:");
  console.log(zadaniaStruct);

  // Navigate to notatki
  console.log("\n=== Notatki ===");
  await page.click('a[href="/notatki"]');
  await page.waitForTimeout(2000);
  bodyText = await page.innerText("body").catch(() => "");
  console.log(bodyText.slice(0, 3000));

  const notatkiStruct = await page.evaluate(() => {
    function walk(el: Element, depth: number): string {
      if (depth > 8) return "";
      const skip = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT"]);
      if (skip.has(el.tagName)) return "";
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls = Array.from(el.classList).slice(0, 3).map(c => `.${c}`).join("");
      const href = el.getAttribute("href") ? `[href="${el.getAttribute("href")}"]` : "";
      const leafText = el.children.length === 0 && el.textContent?.trim() ? ` "${el.textContent.trim().slice(0, 120)}"` : "";
      const indent = "  ".repeat(depth);
      let result = `${indent}${tag}${id}${cls}${href}${leafText}\n`;
      for (const child of el.children) {
        result += walk(child, depth + 1);
      }
      return result;
    }
    return walk(document.body, 0);
  });
  console.log("\nNotatki structure:");
  console.log(notatkiStruct);

  await browser.close();
}

main().catch(console.error);
