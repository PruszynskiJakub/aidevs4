/**
 * Convert a `file://` URI to an absolute filesystem path.
 * Throws on unsupported schemes.
 */
export function resolveUri(uri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid URI: "${uri}"`);
  }

  if (parsed.protocol !== "file:") {
    throw new Error(`Unsupported URI scheme "${parsed.protocol}" — only file:// is supported`);
  }

  // URL decodes percent-encoded characters in pathname
  return decodeURIComponent(parsed.pathname);
}
