# Worker prompt history

TzuDo's ticket instructions already contain the task body, project guidance and public comments. TMatrix still fetches full durable history for conversation routing, context changes and recovery. Fresh model input uses a separate projection of that response.

`serializePromptHistory` replaces long duplicate task, global, project and comment text with references to its source in the ticket instructions. The remaining JSON uses compact formatting. The original instructions and history response stay intact.

The helper requires exact coverage in ordered instruction sections. A task body must match its canonical task and project IDs. Comments must match the entire rendered comment history, including authors and reply targets. Changed text, ambiguous headings, unknown fields, private `inherited_context`, legacy progress and opaque string history remain available. Empty values also remain available so a fresh session can see cleared settings. Short text stays literal when a reference would be longer.

Resumed comment turns still receive the trigger and changed context. Missing conversations use the same compact recovery prompt as a fresh run. No database schema, API response, admin screen or runtime ownership rule changes.

## Measured input size

The committed synthetic fixture exercises the actual `TicketRunner` and captures the input at the runtime boundary. The runtime response is simulated; no task API or paid model call runs. These measurements are prompt characters and UTF-8 bytes, not billed token counts. Both fixtures contain ASCII text, so their character and byte counts match.

| Synthetic ticket | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Initial task, no comments | 20,962 | 12,107 | 42.2% |
| Task with 12 comments and private checkpoint | 38,392 | 22,823 | 40.6% |

The task description appears once after projection. The private checkpoint remains in the 12-comment input. The baseline is commit `6656b5259d525a87ff3c1090eee9bcbf5206ce96`.

Run the measurement from this checkout after `npm ci`:

```sh
node --import tsx scripts/measure-worker-prompt.mjs
```

To measure a base checkout using the same fixture, install its dependencies and pass its absolute path:

```sh
node --import tsx scripts/measure-worker-prompt.mjs /absolute/path/to/base-checkout
```

Run the preservation and missing-conversation checks with:

```sh
npm test -- test/prompt-context.test.ts test/conversation-runner.test.ts
```

## Terminal display limit

The local initial-prompt preview stores at most 200 lines and 16 KiB of JSON-encoded UTF-8. Its display warning does not indicate model-input truncation. Long authoritative instructions can still exceed that preview size. This change does not impose a model-input budget or summarize human requirements.
