import { config } from "../config/index.ts";
import type { ScrapeResult } from "../types/serper.ts";
import { DomainError } from "../types/errors.ts";

export type { ScrapeResult } from "../types/serper.ts";

function getApiKey(): string {
  const key = config.keys.serperApiKey;
  if (!key) throw new DomainError({
    type: "validation",
    message: "SERPER_API_KEY is not configured",
  });
  return key;
}

export async function scrapeUrl(url: string): Promise<ScrapeResult> {
  const response = await fetch(config.urls.serperScrape, {
    method: "POST",
    headers: {
      "X-API-KEY": getApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(config.limits.fetchTimeout),
  });

  if (!response.ok) {
    throw new DomainError({
      type: "provider",
      provider: "serper",
      message: `Scrape failed (${response.status})`,
      internalMessage: `Scrape failed (${response.status}) for ${url.slice(0, 80)}`,
    });
  }

  const data = await response.json();
  const text = data.text ?? data.content ?? data.markdown ?? JSON.stringify(data);

  return { text, url };
}
