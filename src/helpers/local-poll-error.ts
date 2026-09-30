import { toError, WorkerError } from "../errors.js";
import { localPromptPreview } from "./local-prompt-preview.js";

/** Display diagnostic text locally without exposing response bodies or stacks. */
export function localPollError(cause: unknown, apiKey: string): string {
  const error = toError(cause);
  let summary = error instanceof WorkerError
    ? `${error.code}: ${error.message}`
    : error.message;
  // Fetch wraps useful DNS/socket diagnostics in its cause; include only the
  // symbolic code, not arbitrary nested messages or request configuration.
  let nested: unknown = error.cause;
  for (let depth = 0; depth < 3 && nested instanceof Error; depth++) {
    const code = (nested as Error & { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) summary += ` (${code})`;
    nested = nested.cause;
  }
  if (apiKey) summary = summary.replaceAll(apiKey, "[REDACTED]");
  const clean = localPromptPreview(summary).text.replace(/\s+/g, " ").trim();
  return `Poll failed: ${clean.slice(0, 1000) || "Unknown error"}${clean.length > 1000 ? "…" : ""}`;
}
