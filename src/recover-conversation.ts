import { homedir } from "node:os";
import { resolve } from "node:path";
import { ConversationStore } from "./conversation-store.js";

// A separate entry point keeps recovery independent of credentials, adapters,
// polling, and the conversation that is blocked before runtime startup.
const [origin, task, ...flags] = process.argv.slice(2);
try {
  if (!origin || !task || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(task) || flags.some((flag) => flag !== "--confirm-runtime-stopped")) {
    throw new Error("Usage: recover-conversation <API-origin> <canonical-task-id> [--confirm-runtime-stopped]");
  }
  const store = new ConversationStore({
    directory: process.env.CONVERSATION_STATE_DIR
      ? resolve(process.env.CONVERSATION_STATE_DIR)
      : resolve(process.env.XDG_STATE_HOME || resolve(homedir(), ".local", "state"), "aiworker", "conversations"),
    namespace: new URL(origin).origin
  });
  const recovered = await store.recover(task, flags.includes("--confirm-runtime-stopped"));
  process.stdout.write(recovered ? "Stale conversation lock removed. Retry the task in Tzu Do.\n" : "No conversation lock found for this task.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Conversation recovery failed."}\n`);
  process.exitCode = 1;
}
