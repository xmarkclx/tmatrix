import { z } from "zod";

/** Version 3 supports permanent UUIDs and decimal ordered IDs; older servers may ignore this header. */
export const IDENTITY_CONTRACT_HEADERS = { "x-tzudo-identity-version": "3" } as const;

const MAX_SERVER_ID = "9223372036854775807";

/** Accept UUID identities, exact decimal aliases and safe numbers from older servers. */
export const externalIdSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^[1-9][0-9]*$/).refine(
    (value) => value.trim() === value && (value.length < MAX_SERVER_ID.length ||
      (value.length === MAX_SERVER_ID.length && value <= MAX_SERVER_ID)),
    "Server ID exceeds PostgreSQL bigint"
  ),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
]);

/** Reject numeric identity values that JSON cannot represent without data loss. */
function checkIdentityValue(key: string, value: unknown): unknown {
  if (/(?:Ids|_ids)$/.test(key) && Array.isArray(value)) {
    for (const identity of value) checkIdentityValue("id", identity);
  }
  if (/^(?:id|.*Id|.*_id)$/.test(key) && typeof value === "number" &&
      (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Unsafe numeric identity; the server must send a decimal string");
  }
  return value;
}

/** Check nested history and event identities as well as typed poll envelopes. */
export function parseIdentityJson(text: string): unknown {
  return JSON.parse(text, checkIdentityValue);
}

/** Fail before sending rounded IDs in nested progress or result metadata. */
export function stringifyIdentityJson(value: unknown): string {
  const text = JSON.stringify(value, checkIdentityValue);
  if (text === undefined) throw new Error("Request body must be a JSON value");
  return text;
}
