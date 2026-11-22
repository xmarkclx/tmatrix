import { z } from "zod";

const recordSchema = z.record(z.string(), z.unknown());
const sectionNames = [
  "Global Context", "Project Context", "Project Path", "Task", "Ancestor Tasks",
  "AI Work Item", "Complete Comment History", "Required Result"
];

export function serializePromptHistory(instructions: string, history: unknown): string {
  if (typeof history === "string") return history;
  const source = historyRecord(history);
  const sections = instructionSections(instructions);
  if (!source || !sections) return JSON.stringify(history ?? null) ?? "null";

  const task = historyRecord(source.task);
  const taskSection = sections.get("Task");
  if (task && taskSection && typeof task.description === "string" &&
      typeof task.id === "string" && typeof task.projectId === "string" &&
      (task.hiddenContext == null || typeof task.hiddenContext === "string")) {
    const hidden = typeof task.hiddenContext === "string" ? task.hiddenContext : "";
    const body = `${task.description}${hidden ? `\n\n# Hidden Context\n\n${hidden}` : ""}`;
    const suffix = `${body}\n\nCanonical task ID: ${task.id}\nCanonical project ID: ${task.projectId}\nDisplay labels are not action identifiers or route aliases.`;
    if (taskSection.endsWith(`\n\n${suffix}`)) {
      task.description = reference(task.description, "# Task description");
      if (typeof task.hiddenContext === "string") {
        task.hiddenContext = reference(task.hiddenContext, "# Hidden Context in # Task");
      }
      source.task = task;
    }
  }

  if (typeof source.global_context === "string" &&
      sections.get("Global Context") === source.global_context) {
    source.global_context = reference(source.global_context, "# Global Context");
  }

  const projectSection = sections.get("Project Context");
  if (projectSection !== undefined) {
    for (const key of ["task_project", "context_project"]) {
      source[key] = projectContext(source[key], projectSection);
    }
    if (Array.isArray(source.ancestor_projects)) {
      source.ancestor_projects = source.ancestor_projects.map((project) => projectContext(project, projectSection));
    }
  }

  if (Array.isArray(source.comments)) {
    const originalComments = source.comments;
    const comments = originalComments.map(historyRecord);
    const blocks = comments.map((comment) => comment ? commentBlock(comment) : undefined);
    if (blocks.every((block) => block !== undefined) &&
        blocks.join("\n\n") === sections.get("Complete Comment History")) {
      source.comments = comments.map((comment, index) => {
        if (!comment || typeof comment.content !== "string") return originalComments[index];
        comment.content = reference(comment.content, `Comment #${comment.id} in # Complete Comment History`);
        return comment;
      });
    }
  }

  return JSON.stringify(source);
}

function reference(text: string, section: string): string {
  const replacement = `[Same text as ${section} in ticket instructions.]`;
  return text.length > replacement.length ? replacement : text;
}

function instructionSections(instructions: string): Map<string, string> | undefined {
  if (!/^# (Instructions|Global Context|Project Context|Task)\n\n/.test(instructions)) return undefined;
  const headings = [...instructions.matchAll(/^# (Global Context|Project Context|Project Path|Task|Ancestor Tasks|AI Work Item|Complete Comment History|Required Result)\n\n/gm)];
  const sections = new Map<string, string>();
  let previous = -1;
  for (const [index, heading] of headings.entries()) {
    const name = heading[1];
    if (name === undefined) return undefined;
    const order = sectionNames.indexOf(name);
    if (order <= previous) return undefined;
    previous = order;
    const next = headings[index + 1];
    const end = next ? next.index - 2 : instructions.length;
    sections.set(name, instructions.slice(heading.index + heading[0].length, end));
  }
  if (!["Task", "AI Work Item", "Complete Comment History", "Required Result"].every((name) => sections.has(name))) {
    return undefined;
  }
  return sections;
}

function projectContext(value: unknown, section: string): unknown {
  const project = historyRecord(value);
  if (!project || typeof project.context !== "string") return value;
  let covered = section === project.context;
  if (!covered && typeof project.name === "string" && typeof project.id === "string") {
    const header = `## Project: ${project.name.replace(/[\r\n]+/g, " ")} (#${project.id})`;
    const block = `${header}\n\n${project.context}`;
    const start = section.indexOf(block);
    const end = start + block.length;
    covered = start >= 0 && section.indexOf(header) === section.lastIndexOf(header) &&
      (start === 0 || section.slice(start - 2, start) === "\n\n") &&
      (end === section.length || section.slice(end).startsWith("\n\n## Project: "));
  }
  if (covered && typeof project.context === "string") {
    project.context = reference(project.context, "# Project Context");
    return project;
  }
  return value;
}

function commentBlock(comment: Record<string, unknown>): string | undefined {
  if (typeof comment.id !== "string" || typeof comment.authorName !== "string" ||
      typeof comment.content !== "string" ||
      (comment.replyToCommentId != null && typeof comment.replyToCommentId !== "string")) return undefined;
  const reply = comment.replyToCommentId ? ` (reply to #${comment.replyToCommentId})` : "";
  return `## Comment #${comment.id} by ${comment.authorName}${reply}\n\n${comment.content}`;
}

function historyRecord(value: unknown): Record<string, unknown> | undefined {
  if (!recordSchema.safeParse(value).success || typeof value !== "object" || value === null) return undefined;
  return Object.fromEntries(Object.entries(value));
}
