const API_KEY = process.env.HUB_API_KEY!;
const VERIFY_URL = "https://hub.ag3nts.org/verify";
const CSV_URL = `https://hub.ag3nts.org/data/${API_KEY}/categorize.csv`;

async function sendPrompt(prompt: string): Promise<any> {
  const payload = {
    apikey: API_KEY,
    task: "categorize",
    answer: { prompt },
  };
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function parseCSV(text: string): Array<{ code: string; description: string }> {
  const lines = text.trim().split("\n").slice(1); // skip header
  return lines.map((line) => {
    const idx = line.indexOf(",");
    const code = line.slice(0, idx).trim();
    const description = line.slice(idx + 1).trim().replace(/^"|"$/g, "");
    return { code, description };
  });
}

// --- Main ---

// Step 1: Reset
console.log("=== RESET ===");
const resetResult = await sendPrompt("reset");
console.log(JSON.stringify(resetResult, null, 2));

// Step 2: Fetch CSV
console.log("\n=== CSV CONTENTS ===");
const csvRes = await fetch(CSV_URL);
const csvText = await csvRes.text();
const items = parseCSV(csvText);
for (const item of items) {
  console.log(`${item.code}: ${item.description}`);
}

// Step 3: Send prompt for each item individually
// The prompt template - we fill in the actual data
const promptTemplate = (id: string, desc: string) =>
  `Classify as DNG or NEU. DNG=weapons,explosives,ammunition. NEU=everything else including reactor parts. Reply one word.
Item ${id}: ${desc}`;

console.log("\n=== SENDING CLASSIFICATIONS ===");
for (const item of items) {
  const prompt = promptTemplate(item.code, item.description);
  const result = await sendPrompt(prompt);
  console.log(`${item.code}: ${JSON.stringify(result)}`);

  if (result.code < 0) {
    console.log("ERROR - stopping");
    break;
  }
}
