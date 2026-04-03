import { chromium } from "playwright";

const BASE_URL = "https://oko.ag3nts.org";
const API_KEY = process.env.OKO_API_KEY!;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const inputs = await page.$$("input.field-input");
  await inputs[0].fill("Zofia");
  await inputs[1].fill("Zofia2026!");
  await inputs[2].fill(API_KEY);
  await page.click("button.submit-button");
  await page.waitForTimeout(3000);

  // Go to notatki and read the first one about encoding
  await page.click('a[href="/notatki"]');
  await page.waitForTimeout(2000);

  // Click into the first notatka (encoding methods)
  await page.click('a[href="/notatki/380792b2c86d9c5be670b3bde48e187b"]');
  await page.waitForTimeout(2000);
  const bodyText = await page.innerText("body").catch(() => "");
  console.log("=== Notatka: Metody kodowania ===");
  console.log(bodyText);

  await browser.close();
}

main().catch(console.error);
