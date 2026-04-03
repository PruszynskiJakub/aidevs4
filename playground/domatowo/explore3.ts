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
  // Reset
  log("RESET", await api({ action: "reset" }));

  // Create transporter 1 with 2 scouts (spawns at A6)
  const t1 = await api({ action: "create", type: "transporter", passengers: 2 });
  log("T1 CREATED", t1);
  const t1id = t1.object;
  const s1id = t1.crew[0].id;
  const s2id = t1.crew[1].id;

  // Move transporter to E2 (close to NE B3 cluster)
  log("T1 MOVE E2", await api({ action: "move", object: t1id, where: "E2" }));

  // Dismount scouts
  log("T1 DISMOUNT", await api({ action: "dismount", object: t1id, passengers: 2 }));

  // Check objects to see where scouts landed
  log("OBJECTS", await api({ action: "getObjects" }));

  // Check expenses
  log("EXPENSES", await api({ action: "expenses" }));
}

main().catch(console.error);
