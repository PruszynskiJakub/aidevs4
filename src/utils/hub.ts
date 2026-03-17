import { config } from "../config/index.ts";

export function getApiKey(): string {
  return config.hub.apiKey;
}