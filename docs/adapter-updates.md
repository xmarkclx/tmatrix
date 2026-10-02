# Runtime adapter setup and updates

Runtime adapters own their runtime installation policy. The engine loads the
selected adapter, calls its optional `setup(context)` hook once, then uses the
returned `create` function for each worker. An adapter without the hook continues
to use its existing API v1 `create(context, profile)` function.

The bundled Codex adapter uses this hook to initialize its version store, bind
worker creation to immutable executable leases, and expose an updater. Its
stable-release policy, downloads, verification, scheduling, retention and
rollback live behind that adapter. See [Codex updates](codex-updates.md) for the
operator workflow and recovery instructions. Adding another provider does not
require adding its installer or executable selection to the engine, terminal or
shared runtime factory.

## Source organization

Each bundled adapter has a directory under `src/adapters/<adapter-id>/`. Its
`index.ts` exports the adapter, and its provider-specific runtime and helpers
live alongside it. The Codex implementation is organized as:

```text
src/adapters/codex/
  index.ts           Adapter creation, setup and worker version pins
  app-server.ts      Codex App Server process and protocol client
  environment.ts     Child environment sanitization
  factory.ts         Codex runtime factory helper
  prepare-input.ts   Codex input preparation
  probe.ts           Candidate execution, initialization and model checks
  release.ts         Stable release discovery, download and installation
  update-manager.ts  Scheduling, activation, retention and rollback
```

Future bundled providers should keep their implementation in their own adapter
directory. The shared contract (`src/runtime-adapter.ts`), loader
(`src/adapter-loader.ts`) and update lifecycle wrapper (`src/adapter-updates.ts`)
remain outside those directories. External adapters still load through their
configured absolute module path.

## The optional contract

`src/runtime-adapter.ts` defines the interfaces:

| Contract | Responsibility |
| --- | --- |
| `RuntimeAdapter.setup(context)` | Perform local initialization and return an `AdapterSetup`. Clean up resources if setup throws. Avoid network checks that delay worker intake. |
| `AdapterSetupContext` | Sanitized child environment, logger and an `updateDirectory` isolated by adapter and engine instance. |
| `AdapterSetup.create(context, profile)` | Create a fresh runtime for each worker. Select and pin that worker's executable before it can start. |
| `AdapterSetup.updates` | Optional lifecycle and control capability for the runtime updater. Setup may return a creator without an updater. |
| `AdapterUpdates.start()` | Start background checks and the provider's schedule. |
| `AdapterUpdates.snapshot()` | Return compact status, versions, check times and a safe error message. Include `can_rollback: true` only while rollback is available. |
| `AdapterUpdates.checkNow()` | Check asynchronously using the provider's release and validation policy. |
| `AdapterUpdates.rollback()` | Optional operation to activate a retained version for future workers. |
| `AdapterUpdates.close()` | Stop update activity and release updater resources. This does not close workers or release their pins. |

`displayName` identifies the runtime in the terminal. The shared update service
adds the adapter ID and normalizes rollback capability. It contains setup and
updater lifecycle failures so they cannot block worker intake or bypass worker
teardown. Failed setup falls back to the adapter's original creator. Exceptions
from update operations produce a compact generic failure; unavailable status
produces a disabled state while retaining the last known version. Raw exception
messages are not published as update errors. Adapters must also keep their own
status strings free of credentials, runtime output and task data.

The engine calls `start()` without awaiting the provider's initial network
check. The adapter is responsible for bounded requests, serializing conflicting
update operations, stopping timers, and cleaning up subprocesses. The shared
service cannot make an unsafe provider installer safe: each adapter must verify
its candidate and preserve existing execution before activation.

## Example adapter

This schematic example uses a fictional Echo runtime. `createEchoRuntime` and
`initializeEchoUpdates` represent provider-specific implementation, not bundled
TMatrix functions or an installed provider:

```ts
const adapter: RuntimeAdapter = {
  apiVersion: 1,
  id: "echo",
  create: (context, profile) => createEchoRuntime(context, profile),
  async setup(context) {
    const manager = await initializeEchoUpdates(context);
    return {
      create(workerContext, profile) {
        const lease = manager.acquire();
        try {
          const runtime = createEchoRuntime(workerContext, profile, lease.path);
          const close = runtime.close.bind(runtime);
          runtime.close = async () => {
            await close();
            lease.release(); // Only after confirmed process shutdown.
          };
          return runtime;
        } catch (error) {
          lease.release(); // Construction must not start execution.
          throw error;
        }
      },
      updates: {
        displayName: "Echo CLI",
        snapshot: () => manager.snapshot(),
        start: () => manager.start(),
        checkNow: () => manager.checkNow(),
        close: () => manager.close()
      }
    };
  }
};
```

This example omits rollback, so the shared terminal does not offer that action.
An implementation with rollback must expose both the method and current
availability in its snapshot. It must retain installations used by existing
workers even after a newer version becomes current. A failed runtime `close()`
must retain its pin; a stop request is not evidence that execution stopped.

## Shared controls and storage

**Settings → o → Runtime updates** displays the selected adapter's update
capability. **Check now** and optional **Roll back** go through the authenticated
local control server. Adapters without an updater remain usable; their update
controls are unavailable. Authentication, conversation routes, cancellation
receipts, task ownership and drain behavior continue through the existing
runtime lifecycle.

For managed engines the suggested store is `<control-file-directory>/<adapter-id>/`.
Standalone engines use `$XDG_STATE_HOME/tmatrix/<adapter-id>/<instance-hash>/`,
falling back to `~/.local/state` when `XDG_STATE_HOME` is unset. The hash combines
poll origin and instance ID. The Codex locations retain their existing `codex/`
paths so previously installed versions and rollback state remain available.
Each provider owns the format and recovery rules inside its directory.
