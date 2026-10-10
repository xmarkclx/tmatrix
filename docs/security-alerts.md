# Executing-worker security warnings

The executing agent can report concrete suspicious instructions through
`report_security_warning({ category })` while it works. There is no separate
classifier, pre-turn screening request, screening deadline, automatic security
prompt, or automatic screening-unavailable email. Reporting adds no execution
restriction. The task continues under its existing runtime instructions and
permissions. A warning, suppressed delivery, or delivery failure does not itself
pause, cancel, request approval, or change permissions. Actual user cancellation retains its existing
ownership and confirmed-teardown behavior.

The action accepts only one of `credential_theft`, `data_exfiltration`,
`destructive_actions`, `security_bypass`, and `suspicious_instructions`. It cannot
accept an explanation, submitted text, credentials, recipient, URL, ticket ID or
worker ID. Builds, authorized project work, discussion of security threats and
intentional full-access configuration do not by themselves call for a warning.
The agent decides whether a concrete suspicious instruction merits reporting;
this is advisory behavior, not an independent security review or a safety guarantee.

## Runtime integration

The bundled Codex adapter starts a private, stateless loopback MCP endpoint for
one worker runtime. Its random capability token grants only the category action
and expires when that runtime closes. The endpoint validates loopback access,
host, origin, capability, body size and strict tool arguments. It does not log
request bodies, tokens, task text or provider diagnostics. It supports MCP
initialization, tool discovery and calls with JSON responses; notifications
receive an empty 202 response and GET returns 405.

Both fresh and resumed threads receive the MCP integration through per-thread
configuration. This also works for conversations created before the feature,
without rebuilding them or changing their thread ID. The existing operator's
MCP integrations and developer instructions remain configured. TMatrix adds no
security instruction text to fresh or resumed turns. Older conversations may
retain security prompts from previous turns in their history. Updating does not
rewrite that history or reset conversation IDs. The warning server belongs to
the runtime and closes during teardown, including pending startup. If it cannot
start, a safe local diagnostic is recorded and ordinary task execution continues
without that action.

Other API-v1 runtime adapters may implement the optional
`RuntimeThreadOptions.reportSecurityWarning` callback as a category-only model
action and return the host callback's receipt. The engine passes no warning
instruction text to adapters. Adapters that ignore the callback remain
usable. The daemon never fabricates a warning or screening result because an
adapter lacks support.
No generic tool registry, extra dependency, classifier credentials or classifier
model setting is required. Legacy classifier environment variables remain
excluded from runtime child environments but are no longer used.

## Delivery and receipts

The host binds every call to the claimed ticket/run and a SHA-256 digest of its
latest submitted text. Initial input, reconstructed conversation input, remote
steering and submitted local steering update that digest. Explicitly rejected
local steering restores the prior digest; ambiguous delivery keeps the submitted
one. The digest groups duplicate notifications. It does not claim to preserve
an exact copy of whatever suspicious material the agent encountered.

The host sends the existing authenticated POST to the configured app origin at
`/api/v1/alert-user-emergency`. Only ticket/run IDs, the digest and the fixed
category cross that boundary. Tzu Do verifies claim ownership, selects the
account recipient, and constructs its warning email and task links. Queue API
credentials stay in the host; they are not included in prompts or tool arguments.

The action returns a fixed receipt:

| Status | Meaning |
| --- | --- |
| `sent` | The server reports provider acceptance, not confirmed inbox delivery. |
| `test_only` | The server deliberately suppressed email in test mode. |
| `suppressed` | This run already handled the same input/category, or the API throttled the request. |
| `unconfirmed` | Delivery failed, timed out, was cancelled, or returned an unsupported response. |

Delivery takes at most ten seconds, even if a client ignores cancellation. Its
failure cannot fail the task turn. Duplicate accepted reports are suppressed
within the run. Failed or API-throttled reports may be retried by a later action.
Concurrent identical calls share the pending attempt. Tzu Do independently
limits email to one per account per minute and suppresses duplicates for 24
hours. Safe local warning metadata remains available when email is unavailable.
No durable notification outbox or automatic later retry is provided.

The executing agent can miss suspicious instructions or raise false positives.
It reports during execution rather than before any work occurs, and warnings
cannot undo earlier changes. Tests exercise real pinned Codex against a local
fake provider, including old-thread resume, ordinary completion after warning
failure, and preservation of operator instructions/integrations. Those fixtures
verify the mechanism, not the model's detection accuracy or live inbox delivery.
