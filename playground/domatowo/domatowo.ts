const VERIFY_URL = "https://hub.ag3nts.org/verify";
const API_KEY = process.env.HUB_API_KEY!;

async function api(answer: Record<string, unknown>): Promise<unknown> {
  const body = { apikey: API_KEY, task: "domatowo", answer };
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function log(label: string, data: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  log("HELP", await api({ action: "help" }));
  log("MAP", await api({ action: "getMap" }));
}

main().catch(console.error);
