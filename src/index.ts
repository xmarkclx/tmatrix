import { createPromptScreen } from "./security-screening.js";
import { startLocalControlServer, type LocalControlServer } from "./local-control-server.js";
import { LocalWorkerState } from "./local-worker-state.js";
import { ApiClient } from "./api-client.js";
import { loadAdapter, createRuntimeFactory } from "./adapter-loader.js";
import { sanitizedCodexEnvironment } from "./codex-env.js";
import { loadConfig, safeConfig } from "./config.js";
import { ControlClient } from "./control-client.js";
import { errorContext } from "./errors.js";
import { createLogger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { TicketRunner } from "./runner.js";
import { Supervisor } from "./supervisor.js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ConversationStore } from "./conversation-store.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const { logger, close } = createLogger(config);
  const metrics = new Metrics();

  logger.info({
    event: "daemon.starting",
    config: safeConfig(config),
    pid: process.pid,
    node_version: process.version,
    working_directory: process.cwd()
  }, "AI worker daemon starting");

  const adapter = await loadAdapter(config.runtime_adapter, config.adapter_module);

  if (process.argv.includes("--check-config")) {
    logger.info({ event: "config.valid", config: safeConfig(config) }, "Configuration is valid");
    await close();
    return;
  }

  const api = new ApiClient({ config, logger, metrics });
  const codexEnvironment = sanitizedCodexEnvironment(process.env);
  const runtimeFactory = createRuntimeFactory(adapter, { environment: codexEnvironment, logger });
  const conversationStore = new ConversationStore({
    directory: config.conversation_state_dir
      ? resolve(config.conversation_state_dir)
      : resolve(process.env.XDG_STATE_HOME || resolve(homedir(), ".local", "state"), "aiworker", "conversations"),
    // Canonical task IDs are unique within the API origin. Key rotation and
    // separate worker instances must retain the same routing and task locks.
    namespace: config.poll_origin,
    adapterId: adapter.id,
    trackRuntime: adapter.id === "codex",
    runtimeHome: adapter.id === "codex" ? (codexEnvironment.CODEX_HOME ?? resolve(homedir(), ".codex")) : homedir(),
    referenceKey: config.api_key
  });
  const screenPrompt = createPromptScreen({
    apiKey: process.env.TMATRIX_SECURITY_OPENAI_API_KEY,
    model: process.env.TMATRIX_SECURITY_MODEL || "gpt-5-mini",
    alert: (alert, signal) => api.alertUserEmergency(alert, signal), logger,
  });
  const runner = new TicketRunner({ runtimeFactory, api, logger, metrics, conversationStore, screenPrompt });
  let supervisor!: Supervisor;
  const control = new ControlClient({
    config,
    logger,
    metrics,
    onCancellation: (request) => {
      supervisor.handleCancellation(request, "push");
    }
  });
  supervisor = new Supervisor({
    config,
    poller: api,
    runner,
    cancellationApi: api,
    control,
    logger,
    metrics,
    ...(process.env.TMATRIX_CONTROL_FILE ? { localState: new LocalWorkerState(adapter.id) } : {}),
    intakePaused: process.env.TMATRIX_INTAKE_PAUSED === "1"
  });
  let localControl: LocalControlServer | undefined;

  const metricsTimer = setInterval(() => metrics.log(logger, "interval"), config.metrics_interval_ms);
  metricsTimer.unref();
  metrics.log(logger, "startup");

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string, graceMs?: number) => {
    if (shutdownPromise) return shutdownPromise;
    logger.info({ event: "daemon.signal_received", signal }, "Shutdown signal received");
    shutdownPromise = (async () => {
      clearInterval(metricsTimer);
      await supervisor.shutdown(graceMs);
      await localControl?.close();
      metrics.log(logger, "shutdown");
      await close();
    })();
    return shutdownPromise;
  };

  if (process.env.TMATRIX_CONTROL_FILE) {
    localControl = await startLocalControlServer({
      supervisor,
      file: process.env.TMATRIX_CONTROL_FILE,
      port: Number(process.env.TMATRIX_CONTROL_PORT ?? "0"),
      onShutdown: () => { void shutdown("tmatrix"); }
    });
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGUSR1", () => metrics.log(logger, "signal"));

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
