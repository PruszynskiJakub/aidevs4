import OpenAI from "openai";
import { config } from "../../config/index.ts";
import { log } from "./logging/logger.ts";
import type { ModerationResult } from "../../types/moderation.ts";

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI();
  }
  return client;
}

export async function moderateInput(text: string): Promise<ModerationResult> {
  if (!config.moderation.enabled) {
    return { flagged: false, categories: {}, categoryScores: {} };
  }

  try {
    const response = await getClient().moderations.create({
      input: text,
    });

    const result = response.results[0];

    const categories: Record<string, boolean> = {};
    const categoryScores: Record<string, number> = {};

    for (const [key, value] of Object.entries(result.categories)) {
      categories[key] = value;
    }
    for (const [key, value] of Object.entries(result.category_scores)) {
      categoryScores[key] = value;
    }

    const moderationResult: ModerationResult = {
      flagged: result.flagged,
      categories,
      categoryScores,
    };

    if (moderationResult.flagged) {
      const flaggedCategories = Object.entries(categories)
        .filter(([, v]) => v)
        .map(([k]) => k);
      log.error(`Moderation flagged input — categories: ${flaggedCategories.join(", ")}`);
    } else {
      log.debug("Moderation check passed");
    }

    return moderationResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Moderation API error (fail-open): ${message}`);
    return { flagged: false, categories: {}, categoryScores: {} };
  }
}

export function assertNotFlagged(result: ModerationResult): void {
  if (!result.flagged) return;

  const flaggedCategories = Object.entries(result.categories)
    .filter(([, v]) => v)
    .map(([k]) => k);

  throw new Error(
    `Input blocked by moderation policy. Violated categories: ${flaggedCategories.join(", ")}`,
  );
}

/** Override the OpenAI client (for testing) */
export function _setClient(c: OpenAI | undefined): void {
  client = c;
}
