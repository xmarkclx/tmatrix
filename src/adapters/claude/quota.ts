import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CGROUP_ENV } from "../../conversation-cgroup.js";
import { LEASE_ENV } from "../../conversation-recovery.js";
import { ClaudeProcess } from "./process.js";

export type ClaudeQuota = "available" | "exhausted" | "unavailable" | "unknown";

const authSchema = z.object({ loggedIn: z.boolean(), authMethod: z.string() });
const windowSchema = z.object({
  utilization: z.number().min(0).max(100).nullable(),
  resets_at: z.iso.datetime({ offset: true }).nullable()
});
const usageSchema = z.object({
  type: z.literal("control_response"),
  response: z.object({
    request_id: z.string(),
    subtype: z.literal("success"),
    response: z.object({
      subscription_type: z.string().min(1),
      rate_limits_available: z.literal(true),
      rate_limits: z.object({
        five_hour: windowSchema.nullish(),
        seven_day: windowSchema.nullish(),
        seven_day_sonnet: windowSchema.nullish(),
        seven_day_opus: windowSchema.nullish(),
        model_scoped: z.array(windowSchema.extend({ display_name: z.string() })).nullish(),
        extra_usage: z.object({ is_enabled: z.boolean() }).nullish()
      })
    })
  })
});
const MAX_OUTPUT_CHARS = 128 * 1024;

function parseJson(value: string): unknown {
  try { return JSON.parse(value); }
  catch { return undefined; }
}

function modelName(model: string): string {
  return model.trim().toLowerCase().replace(/^claude[- ]/, "").replace(/\[[^\]]*\]$/, "")
    .replace(/[. ]+/g, "-").replace(/-\d{8}$/, "");
}

function usageQuota(lines: string[], requestId: string, selectedModel: string): ClaudeQuota {
  for (const line of lines) {
    const parsed = usageSchema.safeParse(parseJson(line));
    if (!parsed.success || parsed.data.response.request_id !== requestId) continue;
    const usage = parsed.data.response.response.rate_limits;
    const name = modelName(selectedModel);
    const family = name.split("-")[0];
    const legacyWindow = family === "sonnet" ? usage.seven_day_sonnet : family === "opus" ? usage.seven_day_opus : undefined;
    const scoped = (usage.model_scoped ?? []).filter(window => modelName(window.display_name).split("-")[0] === family);
    const applicable = name === family && scoped.length === 1 ? scoped : scoped.filter(window => modelName(window.display_name) === name);
    const windows = [usage.five_hour, usage.seven_day, legacyWindow, ...applicable].filter(window => window != null);
    const now = Date.now();
    const active = windows.filter(window => window.utilization != null && window.resets_at != null && Date.parse(window.resets_at) > now);
    if (active.some(window => window.utilization === 100)) return "exhausted";
    if (active.length > 0 && active.length === windows.length && usage.extra_usage?.is_enabled === false) return "available";
    return "unknown";
  }
  return "unknown";
}

type Output = { code: number | null; lines: string[] } | "unavailable" | "unknown";

async function readOutput(options: {
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  signal: AbortSignal;
  input?: string;
}): Promise<Output> {
  const child = new ClaudeProcess(options.executable, options.args, options.cwd, options.environment);
  const stop = () => { void child.stop().catch(() => undefined); };
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    options.signal.throwIfAborted();
    child.send(options.input ?? "");
    const lines: string[] = [];
    let outputLength = 0;
    for await (const line of child.lines) {
      outputLength += line.length + 1;
      if (outputLength > MAX_OUTPUT_CHARS) return "unknown";
      lines.push(line);
    }
    options.signal.throwIfAborted();
    const exit = await child.exit;
    return exit.kind === "unavailable" ? "unavailable" : { code: exit.code, lines };
  } finally {
    options.signal.removeEventListener("abort", stop);
    await child.stop();
  }
}

export async function readClaudeQuota(
  executable: string,
  environment: Record<string, string>,
  signal?: AbortSignal,
  workingDirectory = process.cwd(),
  selectedModel = "sonnet"
): Promise<ClaudeQuota> {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(10_000);
  const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const env: Record<string, string> = { ...environment, DISABLE_AUTOUPDATER: "1" };
  delete env.API_KEY;
  delete env.CLAUDECODE;
  delete env[LEASE_ENV];
  delete env[CGROUP_ENV];
  const probe = { executable, cwd: workingDirectory, environment: env, signal: probeSignal };
  try {
    const authOutput = await readOutput({ ...probe, args: ["auth", "status", "--json"] });
    if (typeof authOutput === "string") return authOutput;
    const auth = authSchema.safeParse(parseJson(authOutput.lines.join("\n")));
    if (!auth.success) return "unknown";
    if ((authOutput.code === 1 && !auth.data.loggedIn) || (authOutput.code === 0 && auth.data.authMethod !== "claude.ai")) return "unavailable";
    if (authOutput.code !== 0 || !auth.data.loggedIn) return "unknown";
    const requestId = randomUUID();
    const configDirectory = await mkdtemp(join(tmpdir(), "tmatrix-claude-quota-"));
    try {
      // The CLI silently reuses cached usage on HTTP errors. Use a fresh config while retaining its original native credential store.
      const freshEnvironment = {
        ...env, CLAUDE_CONFIG_DIR: configDirectory,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? ""
      };
      const output = await readOutput({
        ...probe,
        environment: freshEnvironment,
        args: ["--safe-mode", "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
          "--no-session-persistence", "--settings", '{"disableAllHooks":true}'],
        input: `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "get_usage" } })}\n`
      });
      return typeof output !== "string" && output.code === 0 ? usageQuota(output.lines, requestId, selectedModel) : "unknown";
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  } catch {
    signal?.throwIfAborted();
    return "unknown";
  }
}
