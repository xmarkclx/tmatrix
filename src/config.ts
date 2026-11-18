import { access, lstat, open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { WorkerError } from "./errors.js";
import { conversationNamespace } from "./source-namespace.js";

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const booleanValue = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

function fileSizeBytes(value: string): number {
  const units: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  return Number(value.slice(0, -1)) * (units[value.slice(-1)] ?? 0);
}

const rawConfigSchema = z.object({
  runtime_adapter: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).default("codex"),
  adapter_module: z.string().refine(isAbsolute, "must be an absolute module path").optional(),
  poll_url: z.string().min(1),
  api_key: z.string().min(1),
  instance_id: z.string().min(1),
  swarm_id: z.string().min(1).optional(),
  // Keep conversation routing outside rotating logs and release directories.
  conversation_state_dir: z.string().min(1).optional(),
  max_workers: z.coerce.number().int().min(1).max(100).default(3),
  // Omit to claim all free slots; a smaller batch does not reduce concurrent runs.
  max_tickets_per_poll: z.coerce.number().int().min(1).max(100).optional(),
  poll_interval_ms: z.coerce.number().int().min(250).default(5_000),
  idle_backoff_max_ms: z.coerce.number().int().min(250).default(60_000),
  request_timeout_ms: z.coerce.number().int().min(100).default(15_000),
  max_request_attempts: z.coerce.number().int().min(1).max(10).default(4),
  control_ping_interval_ms: z.coerce.number().int().min(1_000).default(25_000),
  control_reconnect_max_ms: z.coerce.number().int().min(1_000).default(30_000),
  // -1 is an explicit unlimited drain; zero and positive values retain their
  // existing immediate/timeout cancellation behavior.
  shutdown_grace_ms: z.coerce.number().int().min(-1).default(30_000),
  metrics_interval_ms: z.coerce.number().int().min(1_000).default(60_000),
  log_level: z.enum(logLevels).default("info"),
  pretty_logs: booleanValue.default(false),
  log_dir: z.string().min(1).default("./logs"),
  log_rotate_size: z.string()
    .regex(/^\d+[BKMG]$/, "must look like 50M or 1G")
    .refine((value) => fileSizeBytes(value) >= 64 * 1024, "must be at least 64K")
    .default("50M"),
  log_rotate_interval: z.string().regex(
    /^(?:\d+[Md]|(?:1|2|3|4|6|8|12|24)h|(?:1|2|3|4|5|6|10|12|15|20|30|60)[ms])$/,
    "must be a supported interval such as 1d, 12h, or 30m"
  ).default("1d"),
  log_max_files: z.coerce.number().int().min(1).max(365).default(14)
});

export interface WorkerConfig extends z.infer<typeof rawConfigSchema> {
  poll_url: string;
  poll_origin: string;
}

const ENV_TO_KEY = {
  RUNTIME_ADAPTER: "runtime_adapter",
  ADAPTER_MODULE: "adapter_module",
  POLL_URL: "poll_url",
  API_KEY: "api_key",
  INSTANCE_ID: "instance_id",
  SWARM_ID: "swarm_id",
  CONVERSATION_STATE_DIR: "conversation_state_dir",
  MAX_WORKERS: "max_workers",
  MAX_TICKETS_PER_POLL: "max_tickets_per_poll",
  POLL_INTERVAL_MS: "poll_interval_ms",
  IDLE_BACKOFF_MAX_MS: "idle_backoff_max_ms",
  REQUEST_TIMEOUT_MS: "request_timeout_ms",
  MAX_REQUEST_ATTEMPTS: "max_request_attempts",
  CONTROL_PING_INTERVAL_MS: "control_ping_interval_ms",
  CONTROL_RECONNECT_MAX_MS: "control_reconnect_max_ms",
  SHUTDOWN_GRACE_MS: "shutdown_grace_ms",
  METRICS_INTERVAL_MS: "metrics_interval_ms",
  LOG_LEVEL: "log_level",
  PRETTY_LOGS: "pretty_logs",
  LOG_DIR: "log_dir",
  LOG_ROTATE_SIZE: "log_rotate_size",
  LOG_ROTATE_INTERVAL: "log_rotate_interval",
  LOG_MAX_FILES: "log_max_files"
} as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadFile(path: string, required: boolean): Promise<Record<string, unknown>> {
  if (!(await fileExists(path))) {
    if (required) {
      throw new WorkerError({
        message: `Configuration file not found: ${path}`,
        code: "CONFIG_FILE_NOT_FOUND",
        stage: "config.load",
        details: { config_path: path }
      });
    }
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("Configuration root must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new WorkerError({
      message: `Unable to parse configuration file: ${path}`,
      code: "CONFIG_FILE_INVALID",
      stage: "config.load",
      details: { config_path: path },
      cause
    });
  }
}

function environmentOverrides(env: NodeJS.ProcessEnv): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [envName, configName] of Object.entries(ENV_TO_KEY)) {
    const value = env[envName];
    if (value !== undefined && value !== "") overrides[configName] = value;
  }
  return overrides;
}

function validatePollUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new WorkerError({
      message: "poll_url must be an absolute URL",
      code: "CONFIG_POLL_URL_INVALID",
      stage: "config.validate",
      cause
    });
  }

  if (url.protocol !== "https:") {
    throw new WorkerError({
      message: "poll_url must use HTTPS",
      code: "CONFIG_POLL_URL_INSECURE",
      stage: "config.validate",
      details: { protocol: url.protocol }
    });
  }
  if (url.username || url.password) {
    throw new WorkerError({
      message: "poll_url must not contain credentials",
      code: "CONFIG_POLL_URL_CREDENTIALS",
      stage: "config.validate"
    });
  }
  return url;
}

export async function loadConfig(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
} = {}): Promise<WorkerConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicitPath = options.configPath ?? env.CONFIG_PATH;
  const configPath = resolve(cwd, explicitPath ?? "config.json");
  const fileConfig = await loadFile(configPath, explicitPath !== undefined);
  const candidate = { ...fileConfig, ...environmentOverrides(env) };

  return parseWorkerConfig(candidate);
}

function parseWorkerConfig(candidate: unknown): WorkerConfig {
  const result = rawConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new WorkerError({
      message: "Worker configuration is invalid",
      code: "CONFIG_INVALID",
      stage: "config.validate",
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      }
    });
  }

  const pollUrl = validatePollUrl(result.data.poll_url);
  if (result.data.idle_backoff_max_ms < result.data.poll_interval_ms) {
    throw new WorkerError({
      message: "idle_backoff_max_ms must be at least poll_interval_ms",
      code: "CONFIG_BACKOFF_INVALID",
      stage: "config.validate"
    });
  }

  return {
    ...result.data,
    poll_url: pollUrl.toString(),
    poll_origin: pollUrl.origin
  };
}

export function safeConfig(config: WorkerConfig): Record<string, unknown> {
  return {
    runtime_adapter: config.runtime_adapter,
    poll_url: config.poll_url,
    instance_id: config.instance_id,
    swarm_id: config.swarm_id,
    conversation_state_dir: config.conversation_state_dir,
    max_workers: config.max_workers,
    max_tickets_per_poll: config.max_tickets_per_poll,
    poll_interval_ms: config.poll_interval_ms,
    idle_backoff_max_ms: config.idle_backoff_max_ms,
    request_timeout_ms: config.request_timeout_ms,
    max_request_attempts: config.max_request_attempts,
    control_ping_interval_ms: config.control_ping_interval_ms,
    control_reconnect_max_ms: config.control_reconnect_max_ms,
    shutdown_grace_ms: config.shutdown_grace_ms,
    metrics_interval_ms: config.metrics_interval_ms,
    log_level: config.log_level,
    pretty_logs: config.pretty_logs,
    log_dir: config.log_dir,
    log_rotate_size: config.log_rotate_size,
    log_rotate_interval: config.log_rotate_interval,
    log_max_files: config.log_max_files,
    api_key_configured: config.api_key.length > 0
  };
}


const sourceMetadataSchema = z.object({
  id: z.union([z.literal("legacy"), z.uuid()]),
  name: z.string().min(1).refine(value => Array.from(value).length <= 120, "must contain at most 120 characters").regex(/^[^\x00-\x1f\x7f-\x9f]+$/),
  poll_url: z.string().min(1),
  instance_id: z.string().min(1),
  conversation_namespace: z.string().min(1).max(8192),
  credential_file: z.string().refine(isAbsolute, "must be an absolute credential file path")
}).strict();

export type SourceMetadata = Omit<z.infer<typeof sourceMetadataSchema>, "credential_file">;
export type EngineSource =
  | { kind: "ready"; metadata: SourceMetadata; config: WorkerConfig }
  | { kind: "error"; metadata: SourceMetadata; error: string };
export type ReadySource = Extract<EngineSource, { kind: "ready" }>;
export type EngineConfig = Omit<WorkerConfig, "poll_url" | "poll_origin" | "api_key"> & {
  update_origin: string;
  sources: EngineSource[];
};

const engineConfigSchema = rawConfigSchema.omit({ poll_url: true, api_key: true }).extend({
  update_origin: z.url(),
  sources: z.array(sourceMetadataSchema).max(32)
});

const savedSourcesSchema = z.object({
  version: z.literal(2),
  instance_id: z.string(),
  sources: z.array(sourceMetadataSchema.omit({ credential_file: true }).extend({
    instance_id: z.string().min(1),
    credential_id: z.union([z.literal("legacy"), z.uuid()])
  })).max(32)
});

async function readPrivateSourceFile(path: string, limit: number): Promise<string> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || process.platform !== "win32" && (parent.mode & 0o077) !== 0) throw new Error("Unsafe source directory");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Unsafe source file");
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) return buffer.toString("utf8", 0, total);
      total += bytesRead;
    }
    throw new Error("Source file exceeds size limit");
  } finally {
    await file.close();
  }
}

async function readSourceKey(path: string): Promise<string> {
  const key = (await readPrivateSourceFile(path, 8193)).trim();
  if (!key || key.length > 8192 || /\s|[\x00-\x1f\x7f]/.test(key)) throw new Error("Invalid worker key");
  return key;
}

async function loadReadySource({ metadata, credentialFile, common }: {
  metadata: SourceMetadata; credentialFile: string; common: Omit<EngineConfig, "sources" | "update_origin">;
}): Promise<ReadySource> {
  const api_key = await readSourceKey(credentialFile);
  return { kind: "ready", metadata, config: parseWorkerConfig({ ...common, ...metadata, api_key }) };
}

export async function loadSavedSource({ file, id, engine }: {
  file: string; id: string; engine: EngineConfig;
}): Promise<ReadySource> {
  const candidate: unknown = JSON.parse(await readPrivateSourceFile(file, 64 * 1024));
  const saved = savedSourcesSchema.parse(candidate);
  if (saved.instance_id !== engine.instance_id) throw new Error("Source settings belong to a different engine");
  const requested = saved.sources.filter(source => source.id === id);
  const source = requested[0];
  if (requested.length !== 1 || !source || source.id === "legacy" || source.credential_id === "legacy") {
    throw new Error("Could not find a saved source with a private credential");
  }
  z.uuid().parse(source.instance_id);
  const { credential_id, ...metadata } = source;
  const url = validatePollUrl(metadata.poll_url);
  if (url.search || url.hash) throw new Error("Invalid source poll URL");
  metadata.conversation_namespace = conversationNamespace(metadata.conversation_namespace);
  const { sources: _sources, update_origin: _updateOrigin, ...common } = engine;
  return loadReadySource({ metadata, credentialFile: join(dirname(file), `credentials-${credential_id}`), common });
}

export async function loadEngineConfig(options: Parameters<typeof loadConfig>[0] = {}): Promise<EngineConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicitPath = options.configPath ?? env.CONFIG_PATH;
  const file = await loadFile(resolve(cwd, explicitPath ?? "config.json"), explicitPath !== undefined);
  const candidate = { ...file, ...environmentOverrides(env) };
  if (!("sources" in candidate)) {
    const config = parseWorkerConfig(candidate);
    const { poll_url, poll_origin, api_key, ...common } = config;
    return { ...common, update_origin: poll_origin, sources: [{ kind: "ready", config,
      metadata: { id: "legacy", name: "TzuDo", poll_url, instance_id: config.instance_id, conversation_namespace: poll_origin } }] };
  }
  if ("poll_url" in candidate || "api_key" in candidate) throw new WorkerError({
    message: "Configure either named sources or a single legacy connection, not both",
    code: "CONFIG_SOURCES_AMBIGUOUS", stage: "config.validate"
  });
  const parsed = engineConfigSchema.safeParse(candidate);
  if (!parsed.success) throw new WorkerError({
    message: "Source configuration is invalid", code: "CONFIG_INVALID", stage: "config.validate",
    details: { issues: parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) }
  });
  const { sources: rawSources, update_origin, ...common } = parsed.data;
  const origin = validatePollUrl(update_origin).origin;
  if (common.idle_backoff_max_ms < common.poll_interval_ms) throw new WorkerError({
    message: "idle_backoff_max_ms must be at least poll_interval_ms", code: "CONFIG_BACKOFF_INVALID", stage: "config.validate"
  });
  const ids = new Set<string>();
  const sources: EngineSource[] = [];
  for (const raw of rawSources) {
    if (ids.has(raw.id)) throw new WorkerError({ message: "Source IDs must be unique", code: "CONFIG_SOURCE_DUPLICATE", stage: "config.validate" });
    ids.add(raw.id);
    const { credential_file, ...metadata } = raw;
    validatePollUrl(raw.poll_url);
    metadata.conversation_namespace = conversationNamespace(metadata.conversation_namespace);
    try {
      sources.push(await loadReadySource({ metadata, credentialFile: credential_file, common }));
    } catch {
      sources.push({ kind: "error", metadata, error: "Could not read this source's private worker key. Edit the source connection to save a key." });
    }
  }
  return { ...common, update_origin: origin, sources };
}

export function safeEngineConfig(config: EngineConfig): Record<string, unknown> {
  const { sources, ...common } = config;
  return { ...common, sources: sources.map(source => ({ ...source.metadata, api_key_configured: source.kind === "ready" })) };
}
