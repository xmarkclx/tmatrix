/** Keep the newest whole activity entries within a serialized UTF-8 budget, including metadata. */
export function trimLocalActivity<T extends { text: string }>(activity: T[], maxBytes: number): void {
  const sizes = activity.map((entry) => Buffer.byteLength(JSON.stringify(entry)));
  let bytes = 2 + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, activity.length - 1);
  // Evict whole entries only, even when a single entry exceeds the budget.
  let removed = 0;
  while (bytes > maxBytes && removed < activity.length) {
    const size = sizes[removed]!;
    bytes -= size + (activity.length - removed > 1 ? 1 : 0);
    removed++;
  }
  activity.splice(0, removed);
}
