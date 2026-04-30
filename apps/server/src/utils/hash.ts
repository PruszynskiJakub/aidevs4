import { createHash } from "crypto";

/** Compute md5 hex digest of a string. */
export function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}
