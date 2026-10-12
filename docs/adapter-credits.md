# Adapter credit reporting

`AdapterSetup.credits` is an optional account quota capability in adapter API v1. The engine polls immediately and every 60 seconds. The terminal shows the cached reading above navigation. Ctrl+R requests a refresh from any screen, including an open editor.

```ts
return {
	create: createRuntime,
	credits: {
		displayName: "Claude Code",
		async fetch({ signal }) {
			return {
				windows: [{ label: "Weekly", remaining_percent: 21 }]
			};
		}
	}
};
```

`fetch` receives an `AbortSignal` and returns `{ windows }` or `null`. Each window contains a label and a finite percentage between 0 and 100. Labels must contain 1 to 48 characters and no control characters. The engine accepts at most four windows and copies only these public fields. Display names follow the same label rules. Adapter exceptions and invalid data never expose provider diagnostics through credit status.

A zero percentage is a real exhausted quota. `null` and an empty window list mean that no percentage is available. A successful empty result clears an earlier reading. Failed checks retain earlier percentages with a `stale` marker. Readings also become stale after two minutes without a successful check or when the terminal loses its engine connection.

Automatic and manual requests share one operation. A 15-second deadline aborts a slow fetch. The engine retains the operation slot until the underlying fetch settles, even when an adapter ignores cancellation. Late results after timeout or shutdown are discarded. Engine shutdown waits at most two seconds for credit cleanup. Invalid optional credit configuration does not change the prepared worker factory or updater.

`GET /v1/snapshot` includes optional `adapter_credits` with `adapter_id`, `display_name`, `status`, `refreshing`, and timestamps. `ready` and `stale` readings include `windows` and `last_successful_at`. `unavailable` readings have no windows. Snapshot reads use the cache and never query the provider. The authenticated `POST /v1/adapter/credits/refresh` accepts `{}` and returns HTTP 202 with `{ "ok": true }` after scheduling. An unsupported engine returns HTTP 409. Older adapters omit the capability and retain their existing terminal layout.

The bundled Codex adapter starts a separate short-lived App Server and calls `account/rateLimits/read` with `excludeResetCreditDetails: true`. It does not create a thread, start a turn, or borrow a worker's transport. It selects the Codex quota bucket, with the historical Codex reading as fallback, and reports `max(0, 100 - usedPercent)` for each valid primary or secondary window. Duration labels identify windows such as `5h` and `7d`.

These percentages describe remaining included usage in provider quota windows. Purchased balances and unlimited credit flags have no percentage denominator and do not replace valid usage windows. The percentages do not grant permission to run tasks or predict provider admission. A purchased balance or unlimited flag without usable windows shows `unavailable`.

Every probe acquires the currently selected CLI executable and releases it only after confirmed process teardown. Uncertain teardown retains its version pin and blocks further probes until engine restart. Credit probes have no raw protocol logger. Demo mode uses fictional deterministic readings and never contacts a provider.
