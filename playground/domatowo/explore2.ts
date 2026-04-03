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
  // Reset first
  log("RESET", await api({ action: "reset" }));

  // Get action costs
  log("ACTION COSTS", await api({ action: "actionCost" }));

  // Search for B3 blocks specifically
  log("B3 LOCATIONS", await api({ action: "searchSymbol", symbol: "B3" }));

  // Get map with only B3 and roads
  log("MAP B3+ROADS", await api({ action: "getMap", symbols: ["B3", "UL"] }));

  // Try creating a transporter with 2 scouts
  log("CREATE TRANSPORTER", await api({ action: "create", type: "transporter", passengers: 2 }));

  // Get objects
  log("OBJECTS", await api({ action: "getObjects" }));

  // Check expenses so far
  log("EXPENSES", await api({ action: "expenses" }));
}

main().catch(console.error);
