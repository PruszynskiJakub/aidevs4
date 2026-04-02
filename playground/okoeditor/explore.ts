import { chromium } from "playwright";

const BASE_URL = "https://oko.ag3nts.org";
const API_KEY = "***REMOVED***";

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

  // Get incidents list - extract all links and texts
  console.log("=== INCIDENTS LIST ===");
  const incidents = await page.evaluate(() => {
    const items = document.querySelectorAll("article.list-item");
    return Array.from(items).map(item => {
      const link = item.querySelector("a");
      const href = link?.getAttribute("href") || "";
      const text = item.textContent?.trim().replace(/\s+/g, " ") || "";
      return { href, text };
    });
  });
  for (const inc of incidents) {
    console.log(`${inc.href} => ${inc.text}`);
  }

  // Check each incident detail
  for (const inc of incidents) {
    if (inc.href && inc.href.startsWith("/incydenty/")) {
      await page.goto(BASE_URL + inc.href, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      const detail = await page.innerText("main").catch(() => "");
      console.log(`\n--- DETAIL: ${inc.href} ---`);
      console.log(detail.slice(0, 500));
    }
  }

  // Check zadania details
  console.log("\n\n=== ZADANIA DETAILS ===");
  await page.goto(BASE_URL + "/zadania", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const zadania = await page.evaluate(() => {
    const items = document.querySelectorAll("article.list-item");
    return Array.from(items).map(item => {
      const link = item.querySelector("a.task-main-link");
      const href = link?.getAttribute("href") || "";
      const text = item.textContent?.trim().replace(/\s+/g, " ") || "";
      return { href, text };
    });
  });

  for (const z of zadania) {
    if (z.href && z.href.startsWith("/zadania/")) {
      await page.goto(BASE_URL + z.href, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      const detail = await page.innerText("main").catch(() => "");
      console.log(`\n--- TASK: ${z.href} ---`);
      console.log(detail.slice(0, 500));
    }
  }

  await browser.close();
}

main().catch(console.error);