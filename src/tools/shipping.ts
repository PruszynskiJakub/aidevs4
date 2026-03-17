import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResponse } from "../types/tool.ts";
import { getApiKey } from "../utils/hub.ts";
import { config } from "../config/index.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { toolOk } from "../utils/tool-response.ts";

const PACKAGEID_RE = /^[A-Za-z0-9]+$/;
const PACKAGES_URL = `${config.hub.baseUrl}/api/packages`;

function validateAlphanumeric(value: string, name: string): void {
  if (!PACKAGEID_RE.test(value)) {
    throw new Error(`${name} contains invalid characters — allowed: [A-Za-z0-9]`);
  }
}

async function checkPackage(payload: { packageid: string }): Promise<ToolResponse> {
  assertMaxLength(payload.packageid, "packageid", 20);
  validateAlphanumeric(payload.packageid, "packageid");

  const apiKey = getApiKey();

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

  return toolOk(
    { packageid: payload.packageid, response },
    [`Package ${payload.packageid} status retrieved. Use shipping__redirect to reroute if needed.`],
  );
}

async function redirectPackage(payload: {
  packageid: string;
  destination: string;
  code: string;
}): Promise<ToolResponse> {
  assertMaxLength(payload.packageid, "packageid", 20);
  validateAlphanumeric(payload.packageid, "packageid");
  assertMaxLength(payload.destination, "destination", 20);
  validateAlphanumeric(payload.destination, "destination");
  assertMaxLength(payload.code, "code", 100);

  const apiKey = getApiKey();

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

  return toolOk(
    { packageid: payload.packageid, confirmation: response },
    [
      `Redirect processed. IMPORTANT: Always include the confirmation code in your reply to the operator.`,
      ...(confirmationCode ? [`Confirmation code: ${confirmationCode}`] : []),
    ],
  );
}

async function shipping({ action, payload }: { action: string; payload: Record<string, any> }): Promise<unknown> {
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
