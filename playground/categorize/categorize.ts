/**
 * Categorize task — classify 10 goods as DNG or NEU via hub's internal model.
 * Prompt must fit within 100 tokens including item data.
 * Reactor cassettes must be classified as NEU (training exercise requirement).
 */

const HUB_API_KEY = process.env.HUB_API_KEY!;
const HUB_BASE = "https://hub.ag3nts.org";
const VERIFY_URL = `${HUB_BASE}/verify`;
const CSV_URL = `${HUB_BASE}/data/${HUB_API_KEY}/categorize.csv`;

interface Item {
  code: string;
  description: string;
}

async function fetchCSV(): Promise<Item[]> {
  const res = await fetch(CSV_URL);
  const text = await res.text();
  console.log("CSV content:\n", text);
  const lines = text.trim().split("\n").slice(1); // skip header
  return lines.map((line) => {
    const idx = line.indexOf(",");
    const code = line.slice(0, idx);
    const description = line.slice(idx + 1).replace(/^"|"$/g, "");
    return { code, description };
  });
}

async function sendPrompt(prompt: string): Promise<any> {
  const body = {
    apikey: HUB_API_KEY,
    task: "categorize",
    answer: { prompt },
  };
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function reset(): Promise<void> {
  const result = await sendPrompt("reset");
  console.log("Reset:", JSON.stringify(result));
}

async function run() {
  // 1. Download fresh CSV
  const items = await fetchCSV();
  console.log(`Loaded ${items.length} items\n`);

  // 2. Reset budget
  await reset();

  // 3. Classify each item
  // The prompt template — hub replaces {id} and {description}
  // Reactor items → NEU, dangerous items → DNG, else NEU
  const promptTemplate = `Reply DNG or NEU only. If description mentions reactor: NEU. If item is weapon, explosive, toxic, radioactive (not reactor), flammable: DNG. Else: NEU. ID:{id} DESC:{description}`;

  for (const item of items) {
    const prompt = promptTemplate
      .replace("{id}", item.code)
      .replace("{description}", item.description);

    console.log(`\n--- ${item.code} ---`);
    console.log(`Description: ${item.description}`);
    console.log(`Prompt length: ~${prompt.length} chars`);

    const result = await sendPrompt(prompt);
    console.log("Result:", JSON.stringify(result));

    // If we get a flag, celebrate
    if (result?.message?.includes("FLG:") || result?.flag) {
      console.log("\n🎉 FLAG FOUND:", result.message || result.flag);
    }
  }
}

run().catch(console.error);