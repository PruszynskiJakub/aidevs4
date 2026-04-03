const VERIFY_URL = "https://hub.ag3nts.org/verify";
const API_KEY = process.env.HUB_API_KEY!;

async function api(answer: Record<string, unknown>): Promise<any> {
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
  // Continue from previous state - scout 1 at E1, scout 2 at F2
  const s1 = "7c80c06b8bae2295c772177cb8de87d9";
  const s2 = "21183daa9beec2a3586c96275eb934ee";

  // Scout 2 is already on F2 (B3 block!) - inspect it
  log("INSPECT F2", await api({ action: "inspect", object: s2 }));
  log("LOGS", await api({ action: "getLogs" }));

  // Move scout 1 to F1 and inspect
  log("S1 MOVE F1", await api({ action: "move", object: s1, where: "F1" }));
  log("INSPECT F1", await api({ action: "inspect", object: s1 }));

  // Move scout 2 to G2 and inspect
  log("S2 MOVE G2", await api({ action: "move", object: s2, where: "G2" }));
  log("INSPECT G2", await api({ action: "inspect", object: s2 }));

  // Move scout 1 to G1 and inspect
  log("S1 MOVE G1", await api({ action: "move", object: s1, where: "G1" }));
  log("INSPECT G1", await api({ action: "inspect", object: s1 }));

  // Check all logs
  log("ALL LOGS", await api({ action: "getLogs" }));
  log("EXPENSES", await api({ action: "expenses" }));
}

main().catch(console.error);
