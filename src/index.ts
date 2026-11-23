import { startLocalControlServer, type LocalControlServer } from "./local-control-server.js";
import { LocalWorkerState } from "./local-worker-state.js";
import { ApiClient } from "./api-client.js";
import { claudeModel } from "./adapters/claude/runtime.js";
import { CLAUDE_INSTALL_REQUIRED } from "./adapters/claude/update-manager.js";
import { loadAdapter, setupAdapter } from "./adapter-loader.js";
import { sanitizedCodexEnvironment } from "./adapters/codex/environment.js";
import { loadEngineConfig, loadSavedSource, safeEngineConfig } from "./config.js";
import { ControlClient } from "./control-client.js";
import { errorContext } from "./errors.js";
import { createLogger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { TicketRunner } from "./runner.js";
import { Supervisor } from "./supervisor.js";
import { SourceSupervisor } from "./source-supervisor.js";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { resolveAdapterUpdateDirectory } from "./adapter-updates.js";
import { ConversationStore } from "./conversation-store.js";

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
  const updateDirectory = resolveAdapterUpdateDirectory(adapter.id, config.update_origin, config.instance_id);
  const setupContext = { environment: runtimeEnvironment, logger, updateDirectory };
  const claudeSetup = adapter.id === "claude" ? await setupAdapter(adapter, setupContext) : undefined;
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

  const { runtimeFactory, updates: adapterUpdates } = claudeSetup ?? await setupAdapter(adapter, setupContext);
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
      const conversationStore = new ConversationStore({
        directory: config.conversation_state_dir
          ? resolve(config.conversation_state_dir)
          : resolve(process.env.XDG_STATE_HOME || resolve(homedir(), ".local", "state"), "aiworker", "conversations"),
        namespace: source.metadata.conversation_namespace,
        adapterId: adapter.id,
        trackRuntime: adapter.id === "codex" || adapter.id === "claude",
        runtimeHome: adapter.id === "codex" ? (runtimeEnvironment.CODEX_HOME ?? resolve(homedir(), ".codex"))
          : adapter.id === "claude" ? (runtimeEnvironment.CLAUDE_CONFIG_DIR || resolve(homedir(), ".claude")) : homedir(),
        referenceKey: sourceConfig.api_key
      });
      const runner = new TicketRunner({ runtimeFactory, api, logger: sourceLogger, metrics, conversationStore,
        alertSecurityWarning: (alert, signal) => api.alertUserEmergency(alert, signal) });
      let child!: Supervisor;
      const control = new ControlClient({ config: sourceConfig, logger: sourceLogger, metrics,
        onCancellation: request => { child.handleCancellation(request, "push"); } });
      child = new Supervisor({ config: sourceConfig, poller: api, runner, cancellationApi: api,
        control, logger: sourceLogger, metrics, sharedCapacity,
        ...(process.env.TMATRIX_CONTROL_FILE ? { localState: new LocalWorkerState(adapter.id, adapter.id === "claude" ? claudeModel : undefined) } : {}) });
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
      const updateClosed = adapterUpdates?.close();
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
      ...(adapterUpdates ? { adapterUpdates } : {}),
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

  adapterUpdates?.start();

  if (process.argv.includes("--once")) {
    await supervisor.runOnce();
    await supervisor.drain();
    await shutdown("once_complete");
    return;
  }

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
