import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { WorkerError } from "./errors.js";

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
  team_id: z.uuid().optional(),
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
  TEAM_ID: "team_id",
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
