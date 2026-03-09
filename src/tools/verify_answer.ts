const VERIFY_URL = "https://hub.ag3nts.org/verify";

interface VerifyAnswerArgs {
  task: string;
  answer_file: string;
}

interface VerifyResult {
  task: string;
  response: unknown;
}

export async function verifyAnswer({ task, answer_file }: VerifyAnswerArgs): Promise<VerifyResult> {
  const apiKey = process.env.HUB_API_KEY;
  if (!apiKey) {
    throw new Error("HUB_API_KEY environment variable is not set");
  }

  const content = await Bun.file(answer_file).text();
  const answer = JSON.parse(content);

  const payload = { apikey: apiKey, task, answer };

  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Verify request failed: ${res.status} ${res.statusText}`);
  }

  const response = await res.json();
  return { task, response };
}
