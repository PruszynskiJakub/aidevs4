/**
 * foodwarehouse task — explore the API and database, then build orders.
 *
 * Usage: bun run playground/foodwarehouse/foodwarehouse.ts
 */

const VERIFY_URL = "https://hub.ag3nts.org/verify";
const FOOD_URL = "https://hub.ag3nts.org/dane/food4cities.json";
const API_KEY = process.env.HUB_API_KEY!;

// ─── helpers ───────────────────────────────────────────────────────────
async function api(answer: Record<string, unknown>): Promise<unknown> {
  const body = { apikey: API_KEY, task: "foodwarehouse", answer };
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data;
}

function log(label: string, data: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

// ─── main ──────────────────────────────────────────────────────────────
async function main() {
  // Step 0: Reset to clean state
  log("RESET", await api({ tool: "reset" }));

  // Step 1: Get help
  log("HELP", await api({ tool: "help" }));

  // Step 2: Fetch city requirements
  const foodRes = await fetch(FOOD_URL);
  const food4cities = await foodRes.json();
  log("FOOD4CITIES", food4cities);

  // Step 3: Explore database
  log("TABLES", await api({ tool: "database", query: "show tables" }));

  // Step 4: Explore each table
  log("USERS", await api({ tool: "database", query: "select * from users" }));
  log("CITIES", await api({ tool: "database", query: "select * from cities" }));
  log("ORDERS", await api({ tool: "database", query: "select * from orders" }));

  // Try other common table names
  log("DESTINATIONS", await api({ tool: "database", query: "select * from destinations" }));
  log("PRODUCTS", await api({ tool: "database", query: "select * from products" }));

  // Step 5: Get current orders
  log("CURRENT ORDERS", await api({ tool: "orders", action: "get" }));

  // Step 6: Test signature generator
  log("SIG HELP", await api({ tool: "signatureGenerator" }));
}

main().catch(console.error);
