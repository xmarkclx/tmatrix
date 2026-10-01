# Prompt security alerts (alert-only)

The daemon screens full ticket context before creating an executing runtime,
then each submitted turn, including resumed-context updates, local/remote
steering and missing-conversation fallback prompts. A bounded in-memory cache
avoids checking identical text twice for a run after successful handling.

The policy is compiled into src/security-screening.ts, supplied as the Responses
API instructions, and never populated from project rules or task content.
Submitted text is a separate user input. The classifier has no tools, executing
conversation or filesystem access. Task text cannot select its endpoint, model,
policy or credentials. This does not make the LLM immune to prompt injection or
stop a compromised full-access host from changing worker code.

Set TMATRIX_SECURITY_OPENAI_API_KEY in the daemon environment using a dedicated
OpenAI API credential. The Codex subscription/login is not used by this request.
TMATRIX_SECURITY_MODEL defaults to gpt-5-mini and may be set by the host operator
to a model supporting strict Responses structured output and low reasoning effort.
Neither setting comes from tickets. The credential is removed from the executing
runtime environment, though full host access is not a secret-isolation boundary.
Screening incurs API usage and sends submitted text to OpenAI with store=false;
ordinary provider data policies still apply. Never configure secrets in a task.

A category result triggers an authenticated POST to the configured app origin at
/api/v1/alert-user-emergency. Only ticket/run IDs, a SHA-256 input digest and a
fixed category are sent. Tzu Do selects the verified account recipient and email
text; no recipient or mail credentials live here. Deploy that endpoint first.
Local security.alert warnings appear even when email is unavailable.

Screening has a 15-second timeout and alert delivery a 10-second deadline.
Missing credentials, input over 120,000 characters (never silently truncated),
refusals, malformed results and provider failures report screening_unavailable.
A cancelled run does not start an alert. Alert failures log only safe metadata.
Execution continues after these bounded attempts, including suspicious verdicts;
there is no hold, approval or automatic pause. This adds bounded pre-turn latency.

Tzu Do limits email to one per account per minute and suppresses duplicates for
24 hours. Further warnings remain local. No durable outbox is provided. Provider
acceptance does not prove inbox delivery. Stop active jobs separately from pausing
intake and review queued work before resuming. Alerts cannot undo execution.

The scan covers text, not image pixels, repository files, future tool results or
runtime history unavailable in the ticket. It can miss attacks or raise false
positives. Tests use deterministic model responses; they do not measure attack
detection. Live classifier/inbox verification requires configured test credentials.
