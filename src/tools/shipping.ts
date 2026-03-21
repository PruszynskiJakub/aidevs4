import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { config } from "../config/index.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { createDocument } from "../utils/document.ts";
import { HUB_DOC_META, hubPost, stringify } from "../utils/hub-fetch.ts";

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

  const response = await hubPost(
    PACKAGES_URL,
    { apikey: config.hub.apiKey, action: "check", packageid: payload.packageid },
    "Package check failed",
  );

  return createDocument(
    stringify(response),
    `Package ${payload.packageid} status. Use shipping__redirect to reroute if needed.`,
    HUB_DOC_META,
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

  const response = await hubPost(
    PACKAGES_URL,
    {
      apikey: config.hub.apiKey,
      action: "redirect",
      packageid: payload.packageid,
      destination: payload.destination,
      code: payload.code,
    },
    "Package redirect failed",
  );

  const confirmationCode = typeof response === "object" && response !== null && "confirmation" in response
    ? (response as Record<string, unknown>).confirmation
    : undefined;

  const confirmNote = confirmationCode ? ` Confirmation code: ${confirmationCode}.` : "";
  return createDocument(
    stringify(response),
    `Redirect processed for ${payload.packageid}.${confirmNote} IMPORTANT: Always include the confirmation code in your reply.`,
    HUB_DOC_META,
  );
}

async function shipping({ action, payload }: { action: string; payload: Record<string, unknown> }): Promise<Document> {
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
