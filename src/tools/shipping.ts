import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { config } from "../config/index.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { createDocument } from "../utils/document.ts";

const PACKAGEID_RE = /^[A-Za-z0-9]+$/;
const PACKAGES_URL = `${config.hub.baseUrl}/api/packages`;

function validateAlphanumeric(value: string, name: string): void {
  if (!PACKAGEID_RE.test(value)) {
    throw new Error(`${name} contains invalid characters — allowed: [A-Za-z0-9]`);
  }
}

async function checkPackage(payload: { packageid: string }): Promise<Document> {
  assertMaxLength(payload.packageid, "packageid", 20);
  validateAlphanumeric(payload.packageid, "packageid");

  const apiKey = config.hub.apiKey;

  const res = await fetch(PACKAGES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey, action: "check", packageid: payload.packageid }),
    signal: AbortSignal.timeout(config.limits.fetchTimeout),
  });

  const text = await res.text();
  let response: unknown;
  try { response = JSON.parse(text); } catch { response = text; }

  if (!res.ok) {
    const detail = typeof response === "string" ? response : JSON.stringify(response);
    throw new Error(`Package check failed (${res.status}): ${detail}`);
  }

  const content = typeof response === "string" ? response : JSON.stringify(response);
  return createDocument(
    content,
    `Package ${payload.packageid} status. Use shipping__redirect to reroute if needed.`,
    { source: "hub.ag3nts.org", type: "document", mime_type: "application/json" },
  );
}

async function redirectPackage(payload: {
  packageid: string;
  destination: string;
  code: string;
}): Promise<Document> {
  assertMaxLength(payload.packageid, "packageid", 20);
  validateAlphanumeric(payload.packageid, "packageid");
  assertMaxLength(payload.destination, "destination", 20);
  validateAlphanumeric(payload.destination, "destination");
  assertMaxLength(payload.code, "code", 100);

  const apiKey = config.hub.apiKey;

  const res = await fetch(PACKAGES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apikey: apiKey,
      action: "redirect",
      packageid: payload.packageid,
      destination: payload.destination,
      code: payload.code,
    }),
    signal: AbortSignal.timeout(config.limits.fetchTimeout),
  });

  const text = await res.text();
  let response: unknown;
  try { response = JSON.parse(text); } catch { response = text; }

  if (!res.ok) {
    const detail = typeof response === "string" ? response : JSON.stringify(response);
    throw new Error(`Package redirect failed (${res.status}): ${detail}`);
  }

  const confirmationCode = typeof response === "object" && response !== null && "confirmation" in response
    ? (response as Record<string, unknown>).confirmation
    : undefined;

  const content = typeof response === "string" ? response : JSON.stringify(response);
  const confirmNote = confirmationCode ? ` Confirmation code: ${confirmationCode}.` : "";
  return createDocument(
    content,
    `Redirect processed for ${payload.packageid}.${confirmNote} IMPORTANT: Always include the confirmation code in your reply.`,
    { source: "hub.ag3nts.org", type: "document", mime_type: "application/json" },
  );
}

async function shipping({ action, payload }: { action: string; payload: Record<string, any> }): Promise<Document> {
  switch (action) {
    case "check":
      return checkPackage(payload as { packageid: string });
    case "redirect":
      return redirectPackage(payload as { packageid: string; destination: string; code: string });
    default:
      throw new Error(`Unknown shipping action: ${action}`);
  }
}

export default {
  name: "shipping",
  handler: shipping,
} satisfies ToolDefinition;
