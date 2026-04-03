const VERIFY_URL = "https://hub.ag3nts.org/verify";
const API_KEY = process.env.HUB_API_KEY!;

async function api(answer: Record<string, unknown>): Promise<unknown> {
  const body = { apikey: API_KEY, task: "foodwarehouse", answer };
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
  // Get remaining destinations (40 total, got 30)
  log("DESTINATIONS OFFSET", await api({ tool: "database", query: "select * from destinations limit 20 offset 30" }));

  // Get roles
  log("ROLES", await api({ tool: "database", query: "select * from roles" }));

  // Search for domatowo specifically
  log("DOMATOWO", await api({ tool: "database", query: "select * from destinations where name like '%omat%'" }));

  // Test signature generator with a known user
  log("SIG TEST", await api({
    tool: "signatureGenerator",
    action: "generate",
    login: "tgajewski",
    birthday: "1991-04-06",
    destination: 991828
  }));

  // Check the "done" tool description again - it says "one order" - interesting!
  // Let me re-read: "Validates whether one order fully satisfies all city needs"
  // Hmm wait, the task says "prepare one correct order" but also "create as many orders as cities"
  // Let me check what "done" actually validates
}

main().catch(console.error);
