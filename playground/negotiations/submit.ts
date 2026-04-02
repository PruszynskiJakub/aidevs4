/**
 * Submit negotiations tool URL to hub and poll for result.
 *
 * Usage:
 *   bun run playground/negotiations/submit.ts <BASE_URL>
 *
 * Example:
 *   bun run playground/negotiations/submit.ts https://abc123.ngrok.io
 */

const VERIFY_URL = "https://hub.ag3nts.org/verify";
const TASK = "negotiations";
const API_KEY = process.env.HUB_API_KEY;
if (!API_KEY) throw new Error("HUB_API_KEY env var not set");

const BASE_URL = process.argv[2] || process.env.NEGOTIATIONS_BASE_URL;
if (!BASE_URL) {
  console.error("Usage: bun run playground/negotiations/submit.ts <BASE_URL>");
  console.error("  BASE_URL = your public ngrok/tunnel URL");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(answer: unknown): Promise<any> {
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: API_KEY, task: TASK, answer }),
  });
  return res.json();
}

// Step 1: Submit tool URLs
const toolUrl = `${BASE_URL.replace(/\/$/, "")}/api/negotiations/search`;
console.log(`[submit] Registering tool: ${toolUrl}`);

const submitResp = await post({
  tools: [
    {
      URL: toolUrl,
      description:
        "Search for electronic components by name or description (in Polish). " +
        "Pass the item name or natural language description in the 'params' field. " +
        "Returns a comma-separated list of Polish city names where the item is available for purchase.",
    },
  ],
});
console.log("[submit] Response:", JSON.stringify(submitResp));

// Step 2: Poll for result
console.log("[poll] Waiting 45 seconds for agent to process...");
await sleep(45_000);

for (let attempt = 1; attempt <= 5; attempt++) {
  console.log(`[poll] Check attempt ${attempt}/5`);
  const checkResp = await post({ action: "check" });
  console.log("[poll] Response:", JSON.stringify(checkResp));

  if (checkResp?.message?.includes("{{FLG:")) {
    console.log("\n=== FLAG FOUND ===");
    console.log(checkResp.message);
    break;
  }

  if (attempt < 5) {
    console.log("[poll] No flag yet, waiting 15 seconds...");
    await sleep(15_000);
  }
}
