import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CGROUP_ENV } from "../../conversation-cgroup.js";
import { LEASE_ENV } from "../../conversation-recovery.js";
import type { RuntimeQuota } from "../../runtime-adapter.js";
import { currentResetTime, planResetsAt, resetWindowDisplay, tightestPlanWindow, type PlanWindow, type ResetCadence } from "../../worker-usage.js";
import { RuntimeProcess } from "../process.js";

const unknownQuota = { plan: "unknown" } satisfies RuntimeQuota;

const authSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string(),
  subscriptionType: z.string().nullable().optional()
});
const windowSchema = z.object({
  utilization: z.number().min(0).max(100).nullable().catch(null),
  resets_at: z.iso.datetime({ offset: true }).nullish().catch(undefined)
});
type NativeWindow = z.infer<typeof windowSchema>;
const accountWindowSchema = windowSchema.nullish().catch({ utilization: null, resets_at: undefined });
const usageSchema = z.object({
  type: z.literal("control_response"),
  response: z.object({
    request_id: z.string(),
    subtype: z.literal("success"),
    response: z.object({
      subscription_type: z.string().min(1),
      rate_limits_available: z.literal(true),
      rate_limits: z.object({
        five_hour: accountWindowSchema,
        seven_day: accountWindowSchema,
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

function usageQuota(lines: string[], requestId: string, selectedModel: string): RuntimeQuota {
  for (const line of lines) {
    const parsed = usageSchema.safeParse(parseJson(line));
    if (!parsed.success || parsed.data.response.request_id !== requestId) continue;
    const usage = parsed.data.response.response.rate_limits;
    const name = modelName(selectedModel);
    const family = name.split("-")[0];
    const legacyWindow = family === "sonnet" ? usage.seven_day_sonnet : family === "opus" ? usage.seven_day_opus : undefined;
    const scoped = (usage.model_scoped ?? []).filter(window => modelName(window.display_name).split("-")[0] === family);
    const applicable = name === family && scoped.length === 1 ? scoped : scoped.filter(window => modelName(window.display_name) === name);
    const accountWindows = ([
      { cadence: "five_hour", window: usage.five_hour },
      { cadence: "weekly", window: usage.seven_day }
    ] satisfies { cadence: ResetCadence; window: NativeWindow | null | undefined }[]).filter(({ window }) => window != null);
    const modelWindows = [legacyWindow, ...applicable].filter(window => window != null);
    const now = Date.now();
    const currentAccount = accountWindows.map(entry => ({ ...entry, resetsAtMs: currentResetTime(entry.window?.resets_at, now) }));
    const measure = (window: NativeWindow | null | undefined, resetsAtMs: number | null): PlanWindow[] =>
      window?.utilization != null && resetsAtMs !== null ? [{ usedPercent: window.utilization, resetsAtMs }] : [];
    const account = currentAccount.flatMap(({ window, resetsAtMs }) => measure(window, resetsAtMs));
    if (usage.five_hour?.utilization === 0 && usage.five_hour.resets_at === null) {
      account.push({ usedPercent: 0, resetsAtMs: null });
    }
    const active = [...account, ...modelWindows.flatMap(window => measure(window, currentResetTime(window.resets_at, now)))];
    const exhausted = active.some(window => window.usedPercent === 100);
    const complete = active.length > 0 && active.length === accountWindows.length + modelWindows.length;
    const extraDisabled = usage.extra_usage?.is_enabled === false;
    const accountExhausted = account.some(window => window.usedPercent === 100);
    const limiting = accountExhausted || (account.length > 0 && account.length === accountWindows.length)
      ? tightestPlanWindow(account) : undefined;
    const tiedResetUnknown = limiting && accountWindows.some(({ window }) =>
      window?.utilization === limiting.usedPercent && window.resets_at == null);
    const modelUsage = complete && !exhausted ? tightestPlanWindow(active)?.usedPercent : undefined;
    return {
      plan: exhausted ? "exhausted" : complete && extraDisabled ? "available" : "unknown",
      ...(modelUsage !== undefined && modelUsage !== limiting?.usedPercent ? { usedPercent: modelUsage } : {}),
      display: {
        plan_remaining_percent: limiting ? 100 - limiting.usedPercent : null,
        plan_resets_at: tiedResetUnknown ? null : planResetsAt(limiting),
        ...resetWindowDisplay(currentAccount),
        credits: { kind: extraDisabled ? "disabled" : "unavailable" }
      }
    };
  }
  return unknownQuota;
}

type Output = { code: number | null; lines: string[] } | undefined;

async function readOutput(options: {
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  signal: AbortSignal;
  input?: string;
}): Promise<Output> {
  const child = new RuntimeProcess(options.executable, options.args, options.cwd, options.environment, "Claude Code");
  const stop = () => { void child.stop().catch(() => undefined); };
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    options.signal.throwIfAborted();
    child.send(options.input ?? "");
    const lines: string[] = [];
    let outputLength = 0;
    for await (const line of child.lines) {
      outputLength += line.length + 1;
      if (outputLength > MAX_OUTPUT_CHARS) return;
      lines.push(line);
    }
    options.signal.throwIfAborted();
    const exit = await child.exit;
    if (exit.kind === "exited") return { code: exit.code, lines };
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
): Promise<RuntimeQuota> {
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
    if (!authOutput) return unknownQuota;
    const auth = authSchema.safeParse(parseJson(authOutput.lines.join("\n")));
    if (!auth.success) return unknownQuota;
    const { loggedIn, authMethod, subscriptionType } = auth.data;
    if (authOutput.code === 1 && !loggedIn) return { plan: "unavailable", authenticated: false };
    if (authOutput.code !== 0 || !loggedIn) return unknownQuota;
    if (["api_key", "api_key_helper", "third_party"].includes(authMethod)) return { plan: "unavailable" };
    if (authMethod !== "claude.ai") return unknownQuota;
    if (subscriptionType === null || subscriptionType === "free") return { plan: "unavailable" };
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
      return output?.code === 0 ? usageQuota(output.lines, requestId, selectedModel) : unknownQuota;
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  } catch {
    signal?.throwIfAborted();
    return unknownQuota;
  }
}
