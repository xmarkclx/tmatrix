import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Ticket } from "./types.js";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/worktrees.py", import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs the shared manager without passing shell-interpreted arguments. */
export async function worktrees(...args: string[]): Promise<string> {
  const result = await exec("python3", [script, ...args], { maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

export interface WorktreeLifecycle {
  start(ticket: Ticket, session: string): Promise<string>;
  end(session: string): Promise<void>;
}

/** Registers activity before Codex starts, even when it resumes an old checkout. */
export const worktreeLifecycle: WorktreeLifecycle = {
  async start(ticket, session) {
    if (typeof ticket.task_id !== "string" || !uuid.test(ticket.task_id)) {
      return "\nWorktree policy: do not allocate a managed checkout without a canonical task UUID.";
    }
    await worktrees("session-start", "--task", ticket.task_id, "--session", session);
    const command = `python3 ${JSON.stringify(script)}`;
    return [
      "", "## Before PR work: worktree checklist",
      "First determine delivery intent from the current task and latest human instructions. Only PR-delivery tasks use managed worktrees. Planning, research, and review alone must not allocate a checkout. Reevaluate if human steering requests a PR.",
      "For PR work, use this manager rather than git worktree add. This policy supersedes blanket repository rules requiring worktrees for all tasks.",
      "Before allocating or editing a PR checkout, inspect existing task worktrees and review old managed checkouts for cleanup. Cleanup is an AI pre-task action, never an hourly or allocation side effect.",
      `Inspect: ${command} inventory --repo <repository>. Then dry-run: ${command} cleanup --repo <repository>. Review each candidate; registry timestamps alone do not prove absence of human activity. Verify inactivity and recoverability; skip uncertain candidates, including uncertain ownership or local configuration.`,
      `For each verified safe candidate only: ${command} cleanup --repo <repository> --path <reviewed-checkout> --apply. The helper rechecks safety under its lock and saves verified recovery before normal Git removal. Never force removal or delete branches. If verification is unavailable, skip cleanup and continue the task.`,
      `Acquire/resume: ${command} acquire --repo <repository> --task ${ticket.task_id} --session ${JSON.stringify(session)} --intent pr`,
      "Use the returned checkout path for all task edits. Never silently create suffixed duplicates. Deliberate additional checkouts use --extra <name>; there is no count limit.",
      `Inspect existing trees: ${command} inventory --repo <repository>. Adopt only a verified matching full-UUID branch using adopt --repo <repository> --task ${ticket.task_id} --path <checkout> --intent pr. Ambiguous/manual trees remain unmanaged.`,
      `After opening a PR, register it: ${command} pr --repo <repository> --task ${ticket.task_id} --url <canonical-GitHub-PR-URL> (include --extra when applicable).`,
      "Do not release the worker session yourself. The worker releases it after Codex closes. Cleanup preserves branches and verified recovery archives, protects active/pinned/locked/dirty work, and never forces removal.",
      `Human-use commands: ${command} touch|pin|unpin --repo <repository> --task ${ticket.task_id}. Record human activity with touch; pin before extended manual work.`,
      "Eligibility: 24 hours after verified PR close/merge or recorded human completion (and last use), or 7 days idle. AI completion does not count as human completion. Recreated checkouts restore saved local configuration and dependencies from private recovery storage."
    ].join("\n");
  },
  async end(session) {
    await worktrees("session-end", "--session", session);
  }
};
