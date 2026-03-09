const VERIFY_URL = "https://hub.ag3nts.org/verify";

interface VerifyPayload {
  apikey: string;
  task: string;
  answer: unknown;
}

async function verifyAnswer(task: string, answer: unknown): Promise<unknown> {
  const apiKey = process.env.HUB_API_KEY;
  if (!apiKey) {
    throw new Error("HUB_API_KEY environment variable is not set");
  }

  const payload: VerifyPayload = { apikey: apiKey, task, answer };

  console.log(`Sending to ${VERIFY_URL}`);
  console.log(`Task: ${task}`);
  console.log(`Answer: ${JSON.stringify(answer, null, 2)}`);

  const response = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Verify request failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  console.log(`\nResponse:`, JSON.stringify(result, null, 2));
  return result;
}

// --- CLI ---
// Usage: bun run verify_answer.ts <task_name> <path_to_answer_file>

const [task, filePath] = process.argv.slice(2);

if (!task || !filePath) {
  console.error("Usage: bun run verify_answer.ts <task_name> <path_to_answer_file>");
  console.error("  Example: bun run verify_answer.ts people ./output/people.json");
  process.exit(1);
}

const content = await Bun.file(filePath).text();
const answer = JSON.parse(content);

await verifyAnswer(task, answer);

export { verifyAnswer, type VerifyPayload };
