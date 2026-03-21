import { randomUUID } from "node:crypto";

/** Generate a UUID v4 string for anonymous sessions */
export function randomSessionId(): string {
  return randomUUID();
}
