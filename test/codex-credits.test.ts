import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexCredits, parseCodexCredits } from "../src/adapters/codex/credits.js";
import { AppServerCodex } from "../src/adapters/codex/app-server.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const bucket = { limitId: "codex", primary: { usedPercent: 85, windowDurationMins: 300 },
  secondary: { usedPercent: 79, windowDurationMins: 10080 } };

describe("Codex percentage interpretation", () => {
  it("prefers the Codex bucket and converts both reported usage windows", () => {
    expect(parseCodexCredits({ rateLimitsByLimitId: { other: { ...bucket, primary: { usedPercent: 1 } }, codex: bucket },
      rateLimits: { ...bucket, primary: { usedPercent: 10 } }, accountId: "private", ordinaryUsageAllowed: false }))
      .toEqual({ windows: [{ label: "5h", remaining_percent: 15 }, { label: "7d", remaining_percent: 21 }] });
  });
  it("uses historical Codex data when the map has no usable Codex windows and never shows unrelated products", () => {
    expect(parseCodexCredits({ rateLimitsByLimitId: { other: bucket, codex: { primary: null } }, rateLimits: bucket }))
      .toEqual({ windows: [{ label: "5h", remaining_percent: 15 }, { label: "7d", remaining_percent: 21 }] });
    expect(parseCodexCredits({ rateLimitsByLimitId: { other: bucket }, rateLimits: { ...bucket, limitId: "other" } })).toBeNull();
    expect(parseCodexCredits({ rateLimitsByLimitId: { codex: { ...bucket, limitId: "other" } } })).toBeNull();
    expect(parseCodexCredits({ rateLimitsByLimitId: { codex: { ...bucket, limitId: "other" } }, rateLimits: bucket }))
      .toEqual({ windows: [{ label: "5h", remaining_percent: 15 }, { label: "7d", remaining_percent: 21 }] });
  });
  it("keeps explicit zero, clamps overuse, and skips invalid windows", () => {
    expect(parseCodexCredits({ rateLimits: { primary: { usedPercent: 100 }, secondary: { usedPercent: 102, windowDurationMins: 60 } } }))
      .toEqual({ windows: [{ label: "Primary", remaining_percent: 0 }, { label: "1h", remaining_percent: 0 }] });
    expect(parseCodexCredits({ rateLimits: { primary: { usedPercent: -1 }, secondary: { usedPercent: 50 } } }))
      .toEqual({ windows: [{ label: "Secondary", remaining_percent: 50 }] });
    expect(parseCodexCredits({ rateLimits: { primary: { usedPercent: Number.NaN }, secondary: null } })).toBeNull();
  });
  it("ignores purchased balance and unlimited flags without inventing a denominator", () => {
    expect(parseCodexCredits({ rateLimits: { ...bucket, credits: { unlimited: true, balance: "1000" } } }))
      .toEqual({ windows: [{ label: "5h", remaining_percent: 15 }, { label: "7d", remaining_percent: 21 }] });
    expect(parseCodexCredits({ rateLimits: { credits: { unlimited: false, balance: "1000" } } })).toBeNull();
    expect(parseCodexCredits({ rateLimits: { credits: { unlimited: true } } })).toBeNull();
  });
});

async function fixture(mode = "valid") {
  const directory = await mkdtemp(join(tmpdir(), "tmatrix-credit-probe-"));
  directories.push(directory);
  const executablePath = join(directory, "codex.cjs");
  const trace = join(directory, "trace.jsonl");
  await writeFile(executablePath, `
const fs = require("node:fs");
const lines = require("node:readline").createInterface({ input: process.stdin });
fs.appendFileSync(process.env.PROBE_TRACE, JSON.stringify({ started: process.pid }) + "\\n");
lines.on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.PROBE_TRACE, JSON.stringify({ method: request.method, params: request.params }) + "\\n");
  if (!request.id) return;
  if (request.method === "account/rateLimits/read" && process.env.PROBE_MODE === "hang") return;
  if (request.method === "account/rateLimits/read" && process.env.PROBE_MODE === "fail") {
    console.log(JSON.stringify({ id: request.id, error: { message: "private provider payload" } })); return;
  }
  console.log(JSON.stringify({ id: request.id, result: request.method === "initialize" ? { userAgent: "fixture" }
    : { rateLimits: { primary: { usedPercent: 85, windowDurationMins: 300 }, accountId: "private" } } }));
});
lines.on("close", () => { fs.appendFileSync(process.env.PROBE_TRACE, JSON.stringify({ stopped: true }) + "\\n"); process.exit(0); });
`);
  return { executablePath, trace, environment: { PROBE_TRACE: trace, PROBE_MODE: mode } };
}

describe("Codex account-only probe", () => {
  it("reads quota through a real subprocess without a conversation and releases its executable only after close", async () => {
    const candidate = await fixture();
    let releaseTrace = "";
    const credits = createCodexCredits({ environment: candidate.environment, acquire: () => ({ executablePath: candidate.executablePath,
      release() { releaseTrace = "released"; } }) });
    expect(await credits.fetch({ signal: new AbortController().signal })).toEqual({ windows: [{ label: "5h", remaining_percent: 15 }] });
    const events = (await readFile(candidate.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.method).map(event => event.method)).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    expect(events.find(event => event.method === "account/rateLimits/read").params).toEqual({ excludeResetCreditDetails: true });
    expect(events.at(-1)).toEqual({ stopped: true });
    expect(releaseTrace).toBe("released");
  });
  it("aborts a pending account request and confirms teardown before releasing its version", async () => {
    const candidate = await fixture("hang");
    let released = false;
    const credits = createCodexCredits({ environment: candidate.environment, acquire: () => ({ executablePath: candidate.executablePath,
      release() { released = true; } }) });
    const controller = new AbortController();
    const result = credits.fetch({ signal: controller.signal });
    await vi.waitFor(async () => expect(await readFile(candidate.trace, "utf8")).toContain("account/rateLimits/read"));
    expect(released).toBe(false);
    controller.abort();
    await expect(result).rejects.toThrow();
    expect((await readFile(candidate.trace, "utf8")).trim().split("\n").at(-1)).toBe('{"stopped":true}');
    expect(released).toBe(true);
  });
  it("retains the lease and blocks subsequent subprocesses if teardown is uncertain", async () => {
    const candidate = await fixture();
    const original = AppServerCodex.prototype.close;
    vi.spyOn(AppServerCodex.prototype, "close").mockImplementationOnce(async function(this: AppServerCodex) {
      await original.call(this); throw new Error("unconfirmed");
    });
    let released = false;
    const credits = createCodexCredits({ environment: candidate.environment, acquire: () => ({ executablePath: candidate.executablePath,
      release() { released = true; } }) });
    await expect(credits.fetch({ signal: new AbortController().signal })).rejects.toThrow("shutdown is unconfirmed");
    await expect(credits.fetch({ signal: new AbortController().signal })).rejects.toThrow("shutdown is unconfirmed");
    expect(released).toBe(false);
    const events = (await readFile(candidate.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.started).length).toBe(1);
  });
});
