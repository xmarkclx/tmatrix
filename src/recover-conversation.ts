import { homedir } from "node:os";
import { resolve } from "node:path";
import { ConversationStore } from "./conversation-store.js";
import { conversationNamespace } from "./source-namespace.js";

// A separate entry point keeps recovery independent of credentials, adapters,
// polling, and the conversation that is blocked before runtime startup.
const [origin, task, ...flags] = process.argv.slice(2);
try {
  if (!origin || !task || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(task)) {
    throw new Error("Usage: recover-conversation <API-origin> <canonical-task-id> [--namespace <namespace>] [--confirm-runtime-stopped]");
  }
  let namespace = new URL(origin).origin;
  let confirmed = false;
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === "--confirm-runtime-stopped") confirmed = true;
    else if (flags[index] === "--namespace" && flags[index + 1]) namespace = flags[++index]!;
    else throw new Error("Invalid conversation recovery option");
  }
  const store = new ConversationStore({
    directory: process.env.CONVERSATION_STATE_DIR
      ? resolve(process.env.CONVERSATION_STATE_DIR)
      : resolve(process.env.XDG_STATE_HOME || resolve(homedir(), ".local", "state"), "aiworker", "conversations"),
    namespace: conversationNamespace(namespace)
  });
  const recovered = await store.recover(task, confirmed);
  process.stdout.write(recovered ? "Stale conversation lock removed. Retry the task in its source.\n" : "No conversation lock found for this task.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Conversation recovery failed."}\n`);
  process.exitCode = 1;
}
