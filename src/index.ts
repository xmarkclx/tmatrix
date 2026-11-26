import { startLocalControlServer, type LocalControlServer } from "./local-control-server.js";
import { LocalWorkerState } from "./local-worker-state.js";
import { ApiClient } from "./api-client.js";
import { WorkerUsageReporter } from "./worker-usage.js";
import { claudeModel } from "./adapters/claude/runtime.js";
import { CLAUDE_INSTALL_REQUIRED } from "./adapters/claude/update-manager.js";
import { loadAdapter, setupAdapter } from "./adapter-loader.js";
import { sanitizedCodexEnvironment } from "./adapters/codex/environment.js";
import { loadEngineConfig, loadSavedSource, safeEngineConfig } from "./config.js";
import { ControlClient } from "./control-client.js";
import { errorContext, WorkerError } from "./errors.js";
import { createLogger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { TicketRunner, type RuntimeSelection } from "./runner.js";
import { Supervisor } from "./supervisor.js";
import { SourceSupervisor } from "./source-supervisor.js";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { resolveAdapterUpdateDirectory } from "./adapter-updates.js";
import { ConversationStore } from "./conversation-store.js";
import { chooseFundingRoute, geminiModel, isProvider, modelProvider, providers, type FundingRoute, type Provider, type RuntimePolicy } from "./runtime-routing.js";
import type { ReadRuntimeQuota, RuntimeAdapter, RuntimeQuota } from "./runtime-adapter.js";

const fundingLabels = {
  "codex-plan": `${providers.codex.label} subscription`,
  "claude-plan": `${providers.claude.label} subscription`,
  "codex-credits": `${providers.codex.label} credits`
} satisfies Record<Exclude<FundingRoute, Provider>, string>;

async function checkQuota(probe: ReadRuntimeQuota | undefined, signal?: AbortSignal, cwd?: string, model?: string): Promise<RuntimeQuota> {
  try {
    return await probe?.(signal, cwd, model) ?? { plan: "unknown" };
  } catch {
    signal?.throwIfAborted();
    return { plan: "unknown" };
  }
}

function codexModel(model: string): string {
  return modelProvider(model) === "claude" ? "gpt-6.2-sol" : model;
}

async function main(): Promise<void> {
  const config = await loadEngineConfig();
  const { logger, close } = createLogger(config);
  const sourceMetrics: { metrics: Metrics; logger: typeof logger }[] = [];
  const logMetrics = (reason: Parameters<Metrics["log"]>[1]) => {
    for (const source of sourceMetrics) source.metrics.log(source.logger, reason);
    logger.info({ event: "sources.metrics", reason, running_workers: supervisor.runningCount, reserved_slots: supervisor.reservedSlots }, "Source capacity totals");
  };

  logger.info({
    event: "daemon.starting",
    config: safeEngineConfig(config),
    pid: process.pid,
    node_version: process.version,
    working_directory: process.cwd()
  }, "AI worker daemon starting");

  const adapter = await loadAdapter(config.runtime_adapter, config.adapter_module);
  const runtimeEnvironment = sanitizedCodexEnvironment(process.env);
  const prepare = (runtimeAdapter: RuntimeAdapter) => setupAdapter(runtimeAdapter, {
    environment: runtimeEnvironment,
    logger,
    updateDirectory: resolveAdapterUpdateDirectory(runtimeAdapter.id, config.update_origin, config.instance_id)
  });
  const claudeSetup = adapter.id === "claude" ? await prepare(adapter) : undefined;
  if (claudeSetup && !claudeSetup.updates) throw new Error(CLAUDE_INSTALL_REQUIRED);

  if (process.argv.includes("--check-config")) {
    if (config.sources.some(source => source.kind === "error")) {
      await close();
      throw new Error("One or more sources have an unreadable private worker key");
    }
    await claudeSetup?.updates?.close();
    logger.info({ event: "config.valid", config: safeEngineConfig(config) }, "Configuration is valid");
    await close();
    return;
  }

  const primary = claudeSetup ?? await prepare(adapter);
  const multiProvider = adapter.id === "codex";
  const dedicatedGemini = adapter.id === "gemini";
  let geminiSetup: Promise<Awaited<ReturnType<typeof prepare>>> | undefined;
  const geminiRuntime = () => geminiSetup ??= loadAdapter("gemini").then(prepare);
  let runtimePolicy = config.runtime_policy;
  const secondary = multiProvider ? await prepare(await loadAdapter("claude")) : undefined;
  const claudeFallback = secondary?.readQuota ? secondary : undefined;
  const updaters = [primary.updates, claudeFallback?.updates].filter(updates => updates !== undefined);
  const claudeQuota = adapter.id === "claude" ? primary.readQuota : claudeFallback?.readQuota;
  const usageReporter = new WorkerUsageReporter({
    ...(adapter.id === "codex" && primary.readQuota ? { codex: primary.readQuota } : {}),
    ...(claudeQuota ? { claude: claudeQuota } : {}),
    ...(dedicatedGemini && primary.readQuota ? { gemini: primary.readQuota } : {}),
    ...(multiProvider ? { gemini: async (signal) => checkQuota((await geminiRuntime()).readQuota, signal) } : {})
  }, process.env.TMATRIX_USAGE_SOURCE_ID);
  const conversationDirectory = config.conversation_state_dir
    ? resolve(config.conversation_state_dir)
    : resolve(process.env.XDG_STATE_HOME || resolve(homedir(), ".local", "state"), "aiworker", "conversations");
  const supervisor = new SourceSupervisor({
    config,
    logger,
    intakePaused: process.env.TMATRIX_INTAKE_PAUSED === "1",
    createSupervisor(source, sharedCapacity) {
      const sourceConfig = source.config;
      const sourceLogger = logger.child({ source_id: source.metadata.id, source_name: source.metadata.name });
      const metrics = new Metrics();
      sourceMetrics.push({ metrics, logger: sourceLogger });
      const api = new ApiClient({ config: sourceConfig, logger: sourceLogger, metrics });
      usageReporter.addSource({ id: source.metadata.id, pollUrl: sourceConfig.poll_url,
        publish: (providers, signal) => api.reportWorkerUsage(providers, signal) });
      const storeFor = (id: string) => new ConversationStore({
        directory: conversationDirectory,
        namespace: source.metadata.conversation_namespace,
        adapterId: id,
        trackRuntime: isProvider(id),
        runtimeHome: id === "codex" ? (runtimeEnvironment.CODEX_HOME ?? resolve(homedir(), ".codex"))
          : id === "claude" ? (runtimeEnvironment.CLAUDE_CONFIG_DIR || resolve(homedir(), ".claude"))
            : id === "gemini" ? resolve(runtimeEnvironment.HOME || homedir(), ".gemini", "antigravity-cli") : homedir(),
        referenceKey: sourceConfig.api_key
      });
      const conversationStore = storeFor(adapter.id);
      const claudeStore = claudeFallback ? storeFor("claude") : undefined;
      let geminiStore: ConversationStore | undefined;
      const selectRuntime = async (signal?: AbortSignal, cwd?: string, model?: string, prefer?: string, exclude?: Provider): Promise<RuntimeSelection | undefined> => {
        if (dedicatedGemini) {
          return { id: "gemini", runtimeFactory: primary.runtimeFactory, conversationStore,
            model: geminiModel, label: providers.gemini.label };
        }
        if (!multiProvider) {
          if (modelProvider(model) === "gemini") throw new WorkerError({
            code: "GEMINI_ROUTING_UNAVAILABLE", stage: "runtime.route",
            message: "The selected Gemini model needs a Codex engine with automatic routing or a dedicated Gemini engine."
          });
          return undefined;
        }
        let policy: RuntimePolicy;
        let route: FundingRoute | undefined;
        do {
          policy = runtimePolicy;
          route = await chooseFundingRoute({
            policy,
            requested: modelProvider(model),
            codex: () => exclude === "codex"
              ? Promise.resolve({ plan: "unavailable" })
              : checkQuota(primary.readQuota, signal, cwd),
            claude: () => claudeFallback && exclude !== "claude"
              ? checkQuota(claudeFallback.readQuota, signal, cwd, claudeModel(model ?? "sonnet"))
              : Promise.resolve({ plan: "unavailable" }),
            ...(prefer && isProvider(prefer) ? { prefer } : {}),
            ...(signal ? { signal } : {})
          }).catch(error => {
            if (policy === runtimePolicy) throw error;
            return undefined;
          });
        } while (route === undefined || policy !== runtimePolicy);
        if (route === exclude) throw new WorkerError({
          code: "RUNTIME_QUOTA_UNAVAILABLE", stage: "runtime.route",
          message: "No alternate runtime is available under the selected routing policy."
        });
        const label = isProvider(route) ? providers[route].label : fundingLabels[route];
        const assertPolicy = () => {
          if (policy !== runtimePolicy) throw new WorkerError({
            code: "RUNTIME_POLICY_CHANGED", stage: "runtime.route",
            message: "The routing policy changed before the turn started. Retry with the new policy."
          });
        };
        const assertCurrent = async () => {
          assertPolicy();
          if (policy !== "subscriptions-only" || route !== "codex-plan") return;
          const quota = await checkQuota(primary.readQuota, signal, cwd);
          signal?.throwIfAborted();
          assertPolicy();
          if (quota.plan !== "available") throw new WorkerError({
            code: "RUNTIME_QUOTA_UNAVAILABLE", stage: "runtime.route",
            message: "Codex plan allowance is unavailable. Retry to check the next subscription."
          });
        };
        if (route === "gemini") {
          const gemini = await geminiRuntime();
          signal?.throwIfAborted();
          assertPolicy();
          return { id: "gemini", runtimeFactory: gemini.runtimeFactory, conversationStore: geminiStore ??= storeFor("gemini"),
            model: geminiModel, label, assertCurrent };
        }
        if (route === "claude" || route === "claude-plan") {
          if (!claudeFallback || !claudeStore) throw new WorkerError({
            code: "CLAUDE_INSTALL_REQUIRED", stage: "runtime.route", message: CLAUDE_INSTALL_REQUIRED
          });
          return { id: "claude", runtimeFactory: claudeFallback.runtimeFactory, conversationStore: claudeStore,
            model: claudeModel, label, assertCurrent };
        }
        return { id: "codex", runtimeFactory: primary.runtimeFactory, conversationStore,
          model: codexModel, label, assertCurrent };
      };
      const runner = new TicketRunner({ runtimeFactory: primary.runtimeFactory, api, logger: sourceLogger, metrics, conversationStore,
        ...(isProvider(adapter.id) ? { selectRuntime } : {}),
        alertSecurityWarning: (alert, signal) => api.alertUserEmergency(alert, signal) });
      let child!: Supervisor;
      const control = new ControlClient({ config: sourceConfig, logger: sourceLogger, metrics,
        onCancellation: request => { child.handleCancellation(request, "push"); } });
      child = new Supervisor({ config: sourceConfig, poller: api, runner, cancellationApi: api,
        control, logger: sourceLogger, metrics, sharedCapacity,
        ...(process.env.TMATRIX_CONTROL_FILE ? { localState: new LocalWorkerState(adapter.id, adapter.id === "claude" ? claudeModel : dedicatedGemini ? geminiModel : undefined) } : {}) });
      return child;
    }
  });
  let localControl: LocalControlServer | undefined;

  const metricsTimer = setInterval(() => logMetrics("interval"), config.metrics_interval_ms);
  metricsTimer.unref();
  logMetrics("startup");

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string, graceMs?: number) => {
    if (shutdownPromise) return shutdownPromise;
    logger.info({ event: "daemon.signal_received", signal }, "Shutdown signal received");
    shutdownPromise = (async () => {
      clearInterval(metricsTimer);
      // Abort an update immediately, independently of the worker drain.
      const updateClosed = Promise.all([...updaters.map(updates => updates.close()), usageReporter.close()]);
      await supervisor.shutdown(graceMs);
      await updateClosed;
      await localControl?.close();
      logMetrics("shutdown");
      await close();
    })();
    return shutdownPromise;
  };

  if (process.env.TMATRIX_CONTROL_FILE) {
    const file = process.env.TMATRIX_CONTROL_FILE;
    const settingsFile = process.env.TMATRIX_SOURCE_SETTINGS_FILE;
    const managedSources = settingsFile && isAbsolute(settingsFile) && settingsFile === resolve(dirname(file), "config.json");
    localControl = await startLocalControlServer({
      supervisor,
      ...(primary.updates ? { adapterUpdates: primary.updates } : {}),
      ...(claudeFallback?.updates ? { additionalAdapterUpdates: [claudeFallback.updates] } : {}),
      ...(multiProvider ? { routing: {
        get: () => runtimePolicy,
        set: (policy) => { runtimePolicy = policy; }
      } } : {}),
      ...(managedSources ? { async addSource(id: string) {
        const source = await loadSavedSource({ file: settingsFile, id, engine: config }).catch(() => undefined);
        if (!source) return "invalid";
        return supervisor.addSource(source) ? "applied" : "conflict";
      } } : {}),
      file,
      port: Number(process.env.TMATRIX_CONTROL_PORT ?? "0"),
      onShutdown: () => { void shutdown("tmatrix"); }
    });
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGUSR1", () => logMetrics("signal"));

  const fatal = (kind: string, cause: unknown) => {
    logger.fatal({ event: kind, ...errorContext(cause) }, "Fatal process-level failure");
    process.exitCode = 1;
    // Fatal state is not an operator-requested drain: abort active work now and
    // guarantee systemd receives a nonzero exit even if a child process wedges.
    const hardExit = setTimeout(() => process.exit(1), 10_000);
    hardExit.unref();
    void shutdown(kind, 0).finally(() => {
      clearTimeout(hardExit);
      process.exit(1);
    });
  };
  process.once("uncaughtException", (cause) => fatal("process.uncaught_exception", cause));
  process.once("unhandledRejection", (cause) => fatal("process.unhandled_rejection", cause));

  logger.info({
    event: "daemon.started",
    max_workers: config.max_workers,
    poll_interval_ms: config.poll_interval_ms,
    log_rotation_enabled: true,
    codex_environment_removed: process.env.API_KEY === undefined ? [] : ["API_KEY"]
  }, "AI worker daemon started");

  for (const updates of updaters) updates.start();

  if (process.argv.includes("--once")) {
    await supervisor.runOnce();
    await supervisor.drain();
    await shutdown("once_complete");
    return;
  }

  usageReporter.start();
  await supervisor.run();
  await shutdownPromise;
}

main().catch((cause) => {
  process.stderr.write(`${JSON.stringify({
    level: "fatal",
    time: new Date().toISOString(),
    event: "daemon.bootstrap_failed",
    ...errorContext(cause)
  })}\n`);
  process.exitCode = 1;
});
