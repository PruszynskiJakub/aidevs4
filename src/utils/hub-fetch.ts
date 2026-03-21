import { config } from "../config/index.ts";

/**
 * Coerce unknown response value to string for document text or error messages.
 */
export function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * POST JSON to a hub endpoint with timeout and auth.
 * Parses the response based on content-type; throws on non-OK status.
 */
export async function hubPost(
  url: string,
  body: Record<string, unknown>,
  label: string,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.limits.fetchTimeout),
  });

  const contentType = res.headers.get("content-type") || "";
  const response = contentType.includes("application/json")
    ? await res.json().catch(() => res.text())
    : await res.text();

  if (!res.ok) {
    throw new Error(`${label} (${res.status}): ${stringify(response)}`);
  }

  return response;
}
