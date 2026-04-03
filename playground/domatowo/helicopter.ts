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

async function main() {
  // Call helicopter to F2 where the person was found
  const result = await api({ action: "callHelicopter", destination: "F2" });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
