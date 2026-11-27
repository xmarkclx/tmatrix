import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupAdapter } from "../src/adapter-loader.js";
import adapter from "../src/adapters/gemini/index.js";
import type { ReadRuntimeQuota } from "../src/runtime-adapter.js";

type Fixtures = Record<"usage" | "credits", { output?: unknown; code?: number; stall?: boolean; oversized?: boolean }>;

const usage = {
  status: "SUCCESS",
  response: "",
  num_turns: 0,
  command: {
    name: "usage",
    data: { groups: [
      { name: "Claude and GPT models", buckets: [{ remaining_fraction: 0.01 }] },
      { name: "Gemini Models", buckets: [
        { remaining_fraction: 0.75 }, { remaining_fraction: 0.25 }, { remaining_fraction: null }
      ] },
      { name: "Gemini and Claude Models", buckets: [{ remaining_fraction: 0 }] }
    ] }
  }
};

describe.skipIf(process.platform === "win32")("Gemini usage reporting", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function fixture(commands?: Fixtures): Promise<{ read: ReadRuntimeQuota; directory: string }> {
    const directory = await mkdtemp(join(tmpdir(), "tmatrix-gemini-quota-test-"));
    directories.push(directory);
    const executable = join(directory, "agy");
    if (commands) await writeFile(executable, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const command = value("--print").slice(1);
const configs = ${JSON.stringify(commands)};
if (value("--output-format") !== "json" || !Object.hasOwn(configs, command)) process.exit(1);
const config = configs[command];
writeFileSync(join(__dirname, command + ".json"), JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
  home: process.env.HOME,
  log: value("--log-file"),
  leaked: ["API_KEY", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "TMATRIX_CONVERSATION_LEASE"]
    .some(key => process.env[key] !== undefined)
}));
if (config.oversized) {
  process.stdout.write("é".repeat(100000));
  setInterval(() => {}, 1000);
} else if (config.stall) setInterval(() => {}, 1000);
else {
  console.log(JSON.stringify(config.output));
  process.exitCode = config.code ?? 0;
}
`, { mode: 0o700 });

    const setup = await setupAdapter(adapter, {
      environment: {
        HOME: directory,
        TMATRIX_AGY_PATH: executable,
        API_KEY: "synthetic",
        GEMINI_API_KEY: "synthetic",
        GOOGLE_APPLICATION_CREDENTIALS: "synthetic",
        TMATRIX_CONVERSATION_LEASE: "synthetic"
      },
      updateDirectory: directory,
      logger: { warn() {}, error() {} }
    });
    if (!setup.readQuota) throw new Error("Gemini setup did not provide a quota reader");
    return { read: setup.readQuota, directory };
  }

  it("reports the smallest known Gemini window and exact credit balance in isolated processes", async () => {
    const { read, directory } = await fixture({
      usage: { output: usage },
      credits: { output: {
        status: "SUCCESS", num_turns: 0, response: "",
        command: { name: "credits", data: { remaining_credits: "120.007500" } }
      } }
    });

    await expect(read(undefined, directory)).resolves.toEqual({
      plan: "unknown",
      display: { plan_remaining_percent: 25, plan_resets_at: null, credits: { kind: "amount", amount: "120.007500", unit: "credits" } }
    });
    const readProcess = async (command: string) => JSON.parse(await readFile(join(directory, command + ".json"), "utf8"));
    for (const child of await Promise.all([readProcess("usage"), readProcess("credits")])) {
      expect(child.home).toBe(directory);
      expect(child.leaked).toBe(false);
      expect(child.cwd).not.toBe(directory);
      expect(isAbsolute(child.cwd)).toBe(true);
      expect(child.log).toBe(join(child.cwd, "agy.log"));
      await expect(stat(child.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("preserves zero credits when usage fails authentication", async () => {
    const { read } = await fixture({
      usage: { code: 1, output: { status: "ERROR", error: "Authentication required" } },
      credits: { output: { status: "SUCCESS", response: "Remaining credits\t0\nUpgrade\tignored" } }
    });
    await expect(read()).resolves.toEqual({
      plan: "unknown",
      display: { plan_remaining_percent: null, plan_resets_at: null, credits: { kind: "amount", amount: "0", unit: "credits" } }
    });
  });

  it("reports native usage when credits are unavailable and ignores other groups", async () => {
    const { read } = await fixture({
      usage: { output: {
        status: "SUCCESS",
        response: [
          "Gemini Models\tWeekly Limit Remaining\t40%\t2030-01-02T00:00:00Z",
          "Gemini Models\tFive Hour Limit Remaining\t25%\t2030-01-01T08:00:00+08:00",
          "Claude and GPT models\tWeekly Limit Remaining\t0%\t2030-01-01T00:00:00Z"
        ].join("\n")
      } },
      credits: { code: 1, output: { status: "ERROR", error: "Authentication required" } }
    });
    await expect(read()).resolves.toEqual({
      plan: "unknown",
      display: { plan_remaining_percent: 25, plan_resets_at: "2030-01-01T00:00:00.000Z", credits: { kind: "unavailable" } }
    });
  });

  it.each([
    { fiveHourRemaining: 0.4, fiveHourReset: "2030-01-02T00:00:00Z", expected: "2030-01-01T00:00:00.000Z" },
    { fiveHourRemaining: 0.4, fiveHourReset: undefined, expected: "2030-01-01T00:00:00.000Z" },
    { fiveHourRemaining: 0.25, fiveHourReset: "2030-01-02T00:00:00Z", expected: "2030-01-02T00:00:00.000Z" },
    { fiveHourRemaining: 0.25, fiveHourReset: undefined, expected: null },
    { fiveHourRemaining: 0.25, fiveHourReset: null, expected: null },
    { fiveHourRemaining: 0.25, fiveHourReset: "soon", expected: null },
    { fiveHourRemaining: 0.25, fiveHourReset: "9999-12-31T23:59:59-01:00", expected: null },
    { fiveHourRemaining: 0.25, fiveHourReset: "2020-01-01T00:00:00Z", expected: null }
  ])("reports the Gemini reset for a weekly 25% bucket and five-hour $fiveHourRemaining bucket with reset $fiveHourReset",
    async ({ fiveHourRemaining, fiveHourReset, expected }) => {
      const { read } = await fixture({
        usage: { output: { ...usage,
          response: "Gemini Models\tWeekly Limit Remaining\t0%\t2030-01-03T00:00:00Z",
          command: { name: "usage", data: { groups: [
            { name: "Gemini Models", buckets: [
              { window: "weekly", remaining_fraction: 0.25, reset_time: "2030-01-01T00:00:00Z" },
              { window: "five_hour", remaining_fraction: fiveHourRemaining, reset_time: fiveHourReset }
            ] },
            { name: "Claude and GPT models", buckets: [{ remaining_fraction: 0, reset_time: "2030-01-04T00:00:00Z" }] }
          ] } }
        } },
        credits: { output: { status: "SUCCESS", response: "Remaining credits\t5.001" } }
      });
      await expect(read()).resolves.toEqual({ plan: "unknown", display: {
        plan_remaining_percent: 25, plan_resets_at: expected, credits: { kind: "amount", amount: "5.001", unit: "credits" }
      } });
    });

  it.each([
    { amount: 1.23456789012345, printed: "1.234567890123450", expected: "1.234567890123450" },
    { amount: 123456789012345.12, printed: "123456789012345.123456789012345", expected: "123456789012345.123456789012345" },
    { amount: 1e-7, printed: "0.0000001", expected: "0.0000001" },
    { amount: 0, printed: "", expected: "0" },
    { amount: 1e-7, printed: "", expected: null },
    { amount: 1.2, printed: "1.3", expected: null },
    { amount: "123456789012345.123456789012345", printed: "123456789012345.123456789012346", expected: null },
    { amount: 0, printed: "unavailable", expected: null }
  ])("validates the exact credit amount for $amount and '$printed'", async ({ amount, printed, expected }) => {
    const { read } = await fixture({
      usage: { output: usage },
      credits: { output: {
        status: "SUCCESS", num_turns: 0, response: printed ? `Remaining credits\t${printed}` : "",
        command: { name: "credits", data: { remaining_credits: amount } }
      } }
    });
    await expect(read()).resolves.toEqual({
      plan: "unknown",
      display: {
        plan_remaining_percent: 25, plan_resets_at: null,
        credits: expected === null ? { kind: "unavailable" } : { kind: "amount", amount: expected, unit: "credits" }
      }
    });
  });

  it("stops oversized output before a newline and keeps the other result", async () => {
    const { read, directory } = await fixture({
      usage: { oversized: true },
      credits: { output: { status: "SUCCESS", response: "Remaining credits\t0" } }
    });
    await expect(read()).resolves.toEqual({
      plan: "unknown",
      display: { plan_remaining_percent: null, plan_resets_at: null, credits: { kind: "amount", amount: "0", unit: "credits" } }
    });
    const child = JSON.parse(await readFile(join(directory, "usage.json"), "utf8"));
    expect(() => process.kill(child.pid, 0)).toThrow(/ESRCH/);
    await expect(stat(child.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("omits a display when agy is missing", async () => {
    const { read } = await fixture();
    await expect(read()).resolves.toEqual({ plan: "unknown" });
  });

  it("stops both live processes and removes their working directories on cancellation", async () => {
    const { read, directory } = await fixture({ usage: { stall: true }, credits: { stall: true } });
    const controller = new AbortController();
    const result = read(controller.signal);
    const expectAbort = expect(result).rejects.toMatchObject({ name: "AbortError" });
    try {
      const children = await vi.waitFor(async () => Promise.all(["usage", "credits"].map(async command =>
        JSON.parse(await readFile(join(directory, command + ".json"), "utf8")))), { timeout: 3_000 });
      controller.abort();
      await expectAbort;
      for (const child of children) {
        expect(() => process.kill(child.pid, 0)).toThrow(/ESRCH/);
        await expect(stat(child.cwd)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      controller.abort();
      await expectAbort;
    }
  });
});
