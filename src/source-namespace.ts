export function conversationNamespace(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password) return url.origin;
  } catch {}
  return value;
}
