import { z } from "zod";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { config } from "../config/index.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { hubPost, stringify } from "../utils/hub-fetch.ts";
import { DomainError } from "../types/errors.ts";

const PACKAGEID_RE = /^[A-Za-z0-9]+$/;
const PACKAGES_URL = `${config.hub.baseUrl}/api/packages`;

function validateAlphanumeric(value: string, name: string): void {
  if (!PACKAGEID_RE.test(value)) {
    throw new DomainError({ type: "validation", message: `${name} contains invalid characters — allowed: [A-Za-z0-9]` });
  }
}

async function checkPackage(payload: { packageid: string }): Promise<ToolResult> {
  assertMaxLength(payload.packageid, "packageid", 20);
  validateAlphanumeric(payload.packageid, "packageid");

  const response = await hubPost(
    PACKAGES_URL,
    { apikey: config.hub.apiKey, action: "check", packageid: payload.packageid },
    "Package check failed",
    config.limits.fetchTimeout,
  );

  return text(`${stringify(response)}\nNote: Reroute the package if the current destination is incorrect.`);
}

async function redirectPackage(payload: {
  packageid: string;
  destination: string;
  code: string;
}): Promise<ToolResult> {
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
    config.limits.fetchTimeout,
  );

  const confirmationCode = typeof response === "object" && response !== null && "confirmation" in response
    ? (response as Record<string, unknown>).confirmation
    : undefined;

  const confirmNote = confirmationCode ? ` Confirmation code: ${confirmationCode}.` : "";
  return text(`${stringify(response)}\nRedirect processed for ${payload.packageid}.${confirmNote} IMPORTANT: Always include the confirmation code in your reply.`);
}

async function shipping(args: Record<string, unknown>): Promise<ToolResult> {
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
  switch (action) {
    case "check":
      return checkPackage(payload as { packageid: string });
    case "redirect":
      return redirectPackage(payload as { packageid: string; destination: string; code: string });
    default:
      throw new DomainError({ type: "validation", message: `Unknown shipping action: ${action}` });
  }
}

export default {
  name: "shipping",
  schema: {
    name: "shipping",
    description: "Check package status and redirect packages via the logistics system.",
    actions: {
      check: {
        description: "Check the current status and location of a package. Returns status, location, and tracking details. Use before redirect to confirm package state.",
        schema: z.object({
          packageid: z.string().describe("Package identifier (e.g. PKG12345678)"),
        }),
      },
      redirect: {
        description: "Redirect a package to a new destination. Requires the security code provided by the operator. Returns confirmation with new routing details. Call check first to verify current package state.",
        schema: z.object({
          packageid: z.string().describe("Package identifier (e.g. PKG12345678)"),
          destination: z.string().describe("Target destination code (e.g. PWR3847PL)"),
          code: z.string().describe("Security code provided by the operator for authorization"),
        }),
      },
    },
  },
  handler: shipping,
} satisfies ToolDefinition;
