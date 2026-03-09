export function getApiKey(): string {
  const apiKey = process.env.HUB_API_KEY;
  if (!apiKey) {
    throw new Error("HUB_API_KEY environment variable is not set");
  }
  return apiKey;
}

export function buildHubUrl(url: string): string {
  const parsed = new URL(url);

  if (parsed.hostname !== "hub.ag3nts.org") {
    throw new Error("URL must be from hub.ag3nts.org");
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "data") {
    throw new Error("URL must point to a file: /data/{key}/filename.ext");
  }

  segments[1] = getApiKey();
  parsed.pathname = "/" + segments.join("/");
  return parsed.toString();
}

export function sanitizeUrl(url: string): string {
  const apiKey = process.env.HUB_API_KEY;
  if (apiKey) {
    return url.replaceAll(apiKey, "***");
  }
  return url;
}
