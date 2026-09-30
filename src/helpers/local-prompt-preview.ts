/** A bounded, sanitized copy of prepared input for the authenticated local UI. */
export function localPromptPreview(value: string): { text: string; truncated: boolean; redacted: boolean } {
  const clean = value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  // Defense in depth for common pasted credentials. This is deliberately local
  // memory, never a public-safe export or a replacement for secret handling.
  const sanitized = clean
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, "$1 [REDACTED]")
    .replace(/((?:https?|ssh):\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    // Start only at identifier boundaries; otherwise a long bare word retries
    // the greedy identifier prefix at every character and becomes quadratic.
    .replace(/(?<![a-z0-9_-])(["']?(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED]");
  const maxBytes = 16 * 1024;
  let end = sanitized.split("\n").slice(0, 200).join("\n").length;
  if (Buffer.byteLength(JSON.stringify(sanitized)) > maxBytes) {
    let low = 0;
    let high = end;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(sanitized.slice(0, mid))) <= maxBytes) low = mid;
      else high = mid - 1;
    }
    end = low;
    // Do not leave half of a Unicode surrogate pair at the boundary.
    if (end > 0 && /[\uD800-\uDBFF]/.test(sanitized[end - 1]!)) end--;
  }
  return { text: sanitized.slice(0, end), truncated: end < sanitized.length, redacted: sanitized !== clean };
}
