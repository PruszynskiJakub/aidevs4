import type { DocumentMetadata } from "../types/document.ts";

/** Shared document metadata for hub.ag3nts.org API responses. */
export const HUB_DOC_META: Pick<DocumentMetadata, "source" | "type" | "mimeType"> = {
  source: "hub.ag3nts.org",
  type: "document",
  mimeType: "application/json",
};

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
  timeout: number = 30_000,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
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