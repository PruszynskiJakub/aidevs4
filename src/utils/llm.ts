import OpenAI from "openai";
import { TRANSFORM_MODEL, TRANSFORM_BATCH_SIZE } from "../config.ts";

const openai = new OpenAI();

export async function batchTransform(
  values: string[],
  instructions: string,
  options?: { batchSize?: number; model?: string }
): Promise<string[]> {
  const batchSize = options?.batchSize ?? TRANSFORM_BATCH_SIZE;
  const model = options?.model ?? TRANSFORM_MODEL;
  const results: string[] = [];

  for (let i = 0; i < values.length; i += batchSize) {
    const batch = values.slice(i, i + batchSize);
    const numbered = batch.map((v, idx) => `${i + idx + 1}. ${v}`).join("\n");

    const response = await openai.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `For each numbered text below, apply the following instructions and return the result. Return ONLY the numbered results, one per line, in the format: NUMBER. RESULT\n\nInstructions: ${instructions}`,
        },
        { role: "user", content: numbered },
      ],
    });

    const text = response.choices[0].message.content ?? "";
    const tags = text
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\d+\.\s*/, "").trim());

    if (tags.length !== batch.length) {
      throw new Error(
        `LLM returned ${tags.length} results but expected ${batch.length}. Response:\n${text}`
      );
    }

    results.push(...tags);
    if (i + batchSize < values.length) {
      console.log(`Processed ${Math.min(i + batchSize, values.length)}/${values.length} rows...`);
    }
  }

  return results;
}
