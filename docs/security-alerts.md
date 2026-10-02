# Prompt security alerts (alert-only)

The daemon screens full ticket context before creating an executing runtime,
then each submitted turn, including resumed-context updates, local/remote
steering and missing-conversation fallback prompts. A bounded in-memory cache
avoids checking identical text twice for a run after successful handling.

Screening uses the selected runtime adapter's optional `review(context, request)`
capability. The worker's model, reasoning effort and service tier are reused,
with the adapter's existing provider authentication. No separate classifier API
key or model setting is required. The former `TMATRIX_SECURITY_OPENAI_API_KEY`
and `TMATRIX_SECURITY_MODEL` settings are no longer used; remove them from daemon
configuration. The legacy credential is still stripped from child environments.
Reviews consume the provider account's normal usage/quota and send submitted
text to that provider; ordinary provider data policies still apply.

The policy is compiled into `src/security-screening.ts`, supplied separately from
submitted user text, and never populated from project rules or task content.
The bundled Codex adapter starts a separate App Server process with a pinned
executable and an ephemeral thread in an empty temporary directory. It does not
resume, store or lease an executing worker conversation. A local model descriptor
with no tool support and explicit overrides disable shell, file editing, web,
apps, plugins, hooks, skills and other execution capabilities. Configured MCP
servers are enumerated and individually disabled before the thread starts.
The turn also has read-only sandboxing with command network access disabled;
provider network access remains necessary. Interactive/tool requests fail the
review. The temporary directory and version pin are released after confirmed
process shutdown. Review input/output is excluded from raw protocol diagnostics.

Codex's shared account home can still supply global AGENTS guidance. The fixed
system policy treats this as nonoperative context and reviews only the final
submitted user message; project instructions and skill catalogs are suppressed.
These controls do not make the LLM immune to prompt injection or stop a
compromised full-access host from changing worker code.

Other adapters may implement the same isolated capability without changing
adapter API v1. An adapter without it remains usable and reports
`screening_unavailable`; there is no fallback to its full-access executing
runtime. Adapters must honor cancellation, withhold tools/workspace access, and
finish owned-process teardown before settling their review result. See
[adapter setup](adapter-updates.md).

A category result triggers an authenticated POST to the configured app origin at
`/api/v1/alert-user-emergency`. Only ticket/run IDs, a SHA-256 input digest and a
fixed category are sent. Tzu Do selects the verified account recipient and email
text; no recipient or mail credentials live here. Deploying that endpoint first
is recommended, but updating TMatrix first does not prevent workers running: an
older Tzu Do server's missing endpoint is handled as unconfirmed alert delivery.
Local `security.alert` warnings appear even when email is unavailable. Missed
alerts are not queued for later delivery.

Screening has a 15-second timeout and alert delivery a 10-second deadline.
Unsupported adapters, input over 120,000 characters (never silently truncated),
refusals, malformed results and provider failures report `screening_unavailable`.
A cancelled run does not start an alert. Alert failures log only safe metadata.
Execution continues after these bounded attempts, including suspicious verdicts;
there is no hold, approval or automatic pause. This adds bounded pre-turn latency.

Tzu Do limits email to one per account per minute and suppresses duplicates for
24 hours. Further warnings remain local. No durable outbox is provided. Provider
acceptance does not prove inbox delivery. Stop active jobs separately from pausing
intake and review queued work before resuming. Alerts cannot undo execution.

The scan covers text, not image pixels, repository files, future tool results or
runtime history unavailable in the ticket. It can miss attacks or raise false
positives. Tests include the real pinned Codex CLI against a local fake provider
to verify that no tools are advertised and configured MCP servers do not start.
Deterministic verdict fixtures do not measure attack detection. Live model/inbox
verification requires an authenticated test account.
