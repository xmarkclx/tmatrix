export function sanitizedCodexEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const sanitized = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  // API_KEY authenticates the daemon to the task app. It must not enter the agent process.
  delete sanitized.API_KEY;
  // Each run receives its own lease tag; never inherit an ancestor run's tag.
  delete sanitized.TMATRIX_CONVERSATION_LEASE;
  // App Server receives an honest public clientInfo identity. Never inherit a
  // private originator override from a shell, desktop app, or parent process.
  delete sanitized.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  return sanitized;
}
