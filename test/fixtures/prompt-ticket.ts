import type { Ticket } from "../../src/types.js";

export function promptFixture(commentCount: number) {
  const task = {
    id: 'task-synthetic', projectId: 'project-synthetic', parentId: null,
    title: 'Reduce repeated worker context', displayPrefix: 'RELEASE', displayNumber: '465',
    description: 'TASK_DESCRIPTION: ' + 'Preserve the task requirements and links when preparing the worker prompt.\n'.repeat(80),
    hiddenContext: 'Keep the private task requirements.',
    status: 'AI_PROCESSING', syncState: 'synced', hasAiComment: commentCount > 0,
    isStarred: false, priority: 'none', order: 80896, updatedAt: '2026-10-13T00:00:00Z'
  };
  const global_context = 'GLOBAL_CONTEXT: Explain the result and its mechanics.\n'.repeat(8);
  const context_project = { id: 'project-synthetic', name: 'Release work', description: '', context: 'PROJECT_CONTEXT: Work in a separate clone and deliver a PR.\n'.repeat(12), projectPath: '/tmp' };
  const ancestorProject = { id: 'ancestor-synthetic', name: 'Engineering', description: '', context: 'ANCESTOR_CONTEXT: Preserve human requirements and recovery evidence.\n'.repeat(12), projectPath: '' };
  const ancestor_projects = [ancestorProject];
  const comments = Array.from({ length: commentCount }, (_, index) => ({
    id: `comment-${index}`, authorName: index % 2 ? 'AI worker' : 'Reviewer',
    content: `COMMENT_${index}: ` + 'This review request and its supporting evidence must remain available. '.repeat(8),
    isAI: index % 2 === 1, replyToCommentId: index ? `comment-${index - 1}` : null,
    createdAt: '2026-10-13T00:00:00Z', continuationContext: null
  }));
  const ticket = {
    ticket_id: 'ticket-synthetic', worker_id: 'worker-synthetic', task_id: task.id,
    input_revision: 1, project_path: '/tmp', trigger_comment_id: null, thread_anchor_comment_id: null,
    execution_mode: 'NORMAL', model: 'gpt-6.1-sol', reasoning_effort: 'xhigh', service_tier: 'default', conversation: null,
    endpoints: { mark_taken: 'POST https://example.test/taken', history: 'GET https://example.test/history', progress: 'POST https://example.test/progress', result: 'POST https://example.test/result' },
    instructions: [
      '# Instructions', 'Title this LLM chat as `RELEASE-465: Do we really need to pass durable ticket history`.',
      '# Global Context', global_context, '# Project Context', `## Project: ${ancestorProject.name} (#${ancestorProject.id})\n\n${ancestorProject.context}\n\n## Project: ${context_project.name} (#${context_project.id})\n\n${context_project.context}`, '# Project Path', '`/tmp`',
      '# Task', `# RELEASE-465: ${task.title}`, `${task.description}\n\n# Hidden Context\n\n${task.hiddenContext}\n\nCanonical task ID: ${task.id}\nCanonical project ID: ${task.projectId}\nDisplay labels are not action identifiers or route aliases.`,
      '# AI Work Item', 'This is an explicit initial task handoff.', 'Input revision: 1.',
      '# Complete Comment History', comments.length ? comments.map(c => `## Comment #${c.id} by ${c.authorName}${c.replyToCommentId ? ` (reply to #${c.replyToCommentId})` : ""}\n\n${c.content}`).join('\n\n') : '_No comments yet._',
      '# Required Result', 'Return outcome, compact context_summary and user_message. Do not mark the human task DONE.'
    ].join('\n\n')
  } satisfies Ticket;
  const history = {
    conversation: null, ticket_id: ticket.ticket_id, worker_id: ticket.worker_id, input_revision: 1,
    execution_mode: ticket.execution_mode, model: ticket.model, reasoning_effort: ticket.reasoning_effort, service_tier: ticket.service_tier,
    task, task_project: context_project, context_project, ancestor_projects, ancestor_tasks: [], global_context,
    project_path: '/tmp', thread_anchor_comment_id: null, trigger_comment: null, comments,
    inherited_context: commentCount ? { sourceCommentId: 'comment-1', content: 'SAVED_HANDOFF: The branch exists. Do not repeat the external write.' } : null,
    progress: null
  };
  return { ticket, history };
}
