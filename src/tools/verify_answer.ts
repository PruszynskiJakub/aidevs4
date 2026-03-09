import type { ToolDefinition } from "../types/tool.ts";
import { getApiKey } from "../utils/hub.ts";
import { HUB_VERIFY_URL } from "../config.ts";

interface VerifyResult {
  task: string;
  response: unknown;
}

async function verifyAnswer({
  task,
  answer_file,
}: {
  task: string;
  answer_file: string;
}): Promise<VerifyResult> {
  const apiKey = getApiKey();

  const content = await Bun.file(answer_file).text();
  const answer = JSON.parse(content);

  const payload = { apikey: apiKey, task, answer };

  const res = await fetch(HUB_VERIFY_URL, {
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

export default {
  name: "verify_answer",
  handler: verifyAnswer,
} satisfies ToolDefinition;
