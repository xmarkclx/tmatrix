// Runnable API-v1 example, not a model integration. Never use for real work.
export default {
  apiVersion: 1,
  id: "echo",
  create(_context, profile) {
    let closed = false;
    const thread = {
      async runStreamed(_input, { signal } = {}) {
        return {
          events: (async function* () {
            if (closed) throw new Error("Runtime is closed");
            signal?.throwIfAborted();
            yield { type: "turn.started" };
            yield {
              type: "item.completed",
              item: {
                id: "response", type: "agent_message",
                text: JSON.stringify({
                  outcome: "AI_NEEDS_FEEDBACK",
                  context_summary: "Example adapter ran; no task actions were performed.",
                  user_message: `Echo adapter received a turn for ${profile.model}. Install a real harness adapter to execute tasks.`
                })
              }
            };
            yield {
              type: "turn.completed",
              usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
                output_tokens: 0, reasoning_output_tokens: 0 }
            };
          })()
        };
      }
    };
    return {
      startThread() { return thread; },
      // There are no processes to stop in this example.
      async close() { closed = true; }
    };
  }
};
