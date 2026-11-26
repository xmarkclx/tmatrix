import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeQuota } from "../../runtime-adapter.js";
import type { UsageCredits } from "../../worker-usage.js";
import { RuntimeProcess } from "../process.js";

const resultSchema = z.object({
  status: z.literal("SUCCESS"),
  num_turns: z.literal(0).optional(),
  response: z.string(),
  command: z.object({ name: z.string(), data: z.unknown() }).optional()
});
const fraction = z.number().min(0).max(1);
const bucketSchema = z.object({ remaining_fraction: fraction });
const groupSchema = z.object({ name: z.string(), buckets: z.array(z.unknown()) });
const usageSchema = z.object({ groups: z.array(z.unknown()) });
const amountSchema = z.object({ remaining_credits: z.number().nonnegative().or(z.string()) });
const MAX_OUTPUT_BYTES = 128 * 1024;
const amountPattern = /^\d{1,15}(?:\.\d{1,15})?$/;
const geminiGroup = /^Gemini Models$/i;
const nativeEnvironment = new Set([
  "HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "APPDATA", "LOCALAPPDATA", "USERPROFILE", "SYSTEMROOT", "WINDIR",
  "DBUS_SESSION_BUS_ADDRESS"
]);
type NativeCommand = "usage" | "credits";
type CommandResult = z.infer<typeof resultSchema>;

function planRemaining(result?: CommandResult): number | null {
  const data = usageSchema.safeParse(result?.command?.data);
  const remaining = data.success
    ? data.data.groups.flatMap(entry => {
        const group = groupSchema.safeParse(entry);
        if (!group.success || !geminiGroup.test(group.data.name)) return [];
        return group.data.buckets.flatMap(entry => {
          const bucket = bucketSchema.safeParse(entry);
          return bucket.success ? [bucket.data.remaining_fraction * 100] : [];
        });
      })
    : (result?.response.split(/\r?\n/) ?? []).flatMap(line => {
        const [group, window, percent] = line.split("\t");
        if (!geminiGroup.test(group ?? "") ||
            !/^(?:Weekly|Five Hour|5 Hour) Limit Remaining$/.test(window ?? "") ||
            !/^\d{1,3}(?:\.\d+)?%$/.test(percent ?? "")) return [];
        const value = Number(percent?.slice(0, -1));
        return value <= 100 ? [value] : [];
      });
  return remaining.length ? Math.min(...remaining) : null;
}

function normalizeAmount(amount: string): string {
  const [digits, fraction = ""] = amount.split(".");
  return `${digits?.replace(/^0+(?=\d)/, "")}.${fraction.replace(/0+$/, "")}`;
}

function creditAmount(result: CommandResult): string | undefined {
  const printedAmounts = result.response.split(/\r?\n/)
    .filter(line => line === "Remaining credits" || line.startsWith("Remaining credits\t"))
    .map(line => line.slice("Remaining credits\t".length));
  const printed = printedAmounts[0];
  if (printedAmounts.length > 1 || (printed !== undefined && !amountPattern.test(printed))) return;
  if (!result.command) return printed;

  const parsed = amountSchema.safeParse(result.command.data);
  if (!parsed.success) return;
  const amount = parsed.data.remaining_credits;
  if (typeof amount === "string") {
    if (amountPattern.test(amount) && (printed === undefined || normalizeAmount(printed) === normalizeAmount(amount))) {
      return amount;
    }
  } else if (printed !== undefined) {
    // JSON.parse can round numeric decimals. Use the native decimal text after checking it agrees numerically.
    if (Number(printed) === amount) return printed;
  } else if (Number.isSafeInteger(amount) && amountPattern.test(String(amount))) {
    return String(amount);
  }
}

function readCredits(result?: CommandResult): UsageCredits {
  const amount = result && creditAmount(result);
  return amount === undefined ? { kind: "unavailable" } : { kind: "amount", amount, unit: "credits" };
}

async function runNativeCommand(options: {
  executable: string;
  command: NativeCommand;
  environment: Record<string, string>;
  signal: AbortSignal;
}): Promise<CommandResult | undefined> {
  let cwd: string | undefined;
  try {
    options.signal.throwIfAborted();
    cwd = await mkdtemp(join(tmpdir(), "tmatrix-agy-quota-"));
    options.signal.throwIfAborted();
    const child = new RuntimeProcess(options.executable, [
      "--output-format", "json", "--print-timeout", "6s", "--log-file", join(cwd, "agy.log"),
      "--print", `/${options.command}`
    ], cwd, options.environment, "Antigravity CLI quota", MAX_OUTPUT_BYTES);
    const stop = () => { void child.stop().catch(() => undefined); };
    options.signal.addEventListener("abort", stop, { once: true });
    try {
      child.endInput();
      let output = "";
      for await (const line of child.lines) output += line + "\n";
      const exit = await child.exit;
      if (options.signal.aborted || child.outputLimitExceeded || exit.kind !== "exited" || exit.code !== 0) return;
      const result = resultSchema.safeParse(JSON.parse(output));
      if (result.success && (!result.data.command || result.data.command.name === options.command)) return result.data;
    } finally {
      options.signal.removeEventListener("abort", stop);
      await child.stop();
    }
  } catch {
    // Native errors may include account details. Only validated display fields leave the probe.
    return;
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function readGeminiQuota(
  executable: string,
  environment: Record<string, string>,
  signal?: AbortSignal
): Promise<RuntimeQuota> {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(8_000);
  const probe = {
    executable,
    environment: {
      ...Object.fromEntries(Object.entries(environment).filter(([key]) => nativeEnvironment.has(key.toUpperCase()))),
      LC_ALL: "C"
    },
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline
  };
  const [usage, credits] = await Promise.all([
    runNativeCommand({ ...probe, command: "usage" }),
    runNativeCommand({ ...probe, command: "credits" })
  ]);
  signal?.throwIfAborted();
  return { plan: "unknown", display: { plan_remaining_percent: planRemaining(usage), credits: readCredits(credits) } };
}
