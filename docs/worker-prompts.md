# Worker prompt history

TMatrix fetches durable history once per ticket. It uses the full response to find the conversation and detect changes to task context. Only the prompt and the history tool determine which parts the model sees.

A resumed conversation receives the latest triggering comment and changed task context. Codex can call `read_ticket_history` when it needs an older comment. Call it without arguments to list recent comment IDs, with `before_comment_id` to page backward, or with `comment_id` to read a single comment. The tool serves the active ticket's history from memory and can return the private continuation selected for this reply.

A fresh conversation, including recovery when a saved conversation is missing, receives the task instructions and current request. When the worker can prove that the full comment section matches the fetched history, it replaces that section with lookup instructions. If a saved continuation exists, the prompt gives its comment ID and asks the model to read it before acting on prior work. The latest human instructions still take precedence. The tool stays available for the life of the runtime.

The worker sends the complete comment section and continuation when it cannot validate the snapshot or prepare the lookup. It also uses the full prompt for history containing image links so images can still be attached to the turn. Live human edits still carry TzuDo's authoritative conversation snapshot. The `serializePromptHistory` helper removes proven duplicate copies in the JSON supplement on both paths.

## Measured initial input size

The synthetic fixture captures the input `TicketRunner` hands to its runtime. The table measures UTF-8 bytes before the model reads any comments. It excludes provider overhead and follow-up tool calls.

| Synthetic ticket | Full history | On-demand history |
| --- | ---: | ---: |
| No comments | 12,173 | 12,173 |
| 12 comments and a saved continuation | 23,310 | 12,564 |
| 100 comments and a saved continuation | 104,933 | 12,564 |

Run the measurement with `node --import tsx scripts/measure-worker-prompt.mjs` after `npm ci`.

## Terminal display limit

The local initial-prompt preview stores at most 200 lines and 16 KiB of JSON-encoded UTF-8. The terminal displays a notice when it shows an excerpt. Long task instructions can still exceed the display limit.
