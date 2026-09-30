/** Stable task inputs only: exclude status, timestamps, history and delivery bookkeeping. */
export function conversationContext(history: unknown): Record<string, unknown> {
  if (!history || typeof history !== "object" || Array.isArray(history)) return {};
  const source = history as Record<string, unknown>;
  const context: Record<string, unknown> = {};
  for (const key of ["global_context", "project_path", "ancestor_tasks", "ancestor_projects", "task_project", "context_project"]) {
    if (Object.hasOwn(source, key)) context[key] = source[key] ?? null;
  }
  if (source.task && typeof source.task === "object") {
    const task = source.task as Record<string, unknown>;
    for (const key of ["title", "description", "hiddenContext"]) {
      if (Object.hasOwn(task, key)) context[`task.${key}`] = task[key] ?? null;
    }
  }
  return context;
}
