import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppServerCodex,
  resolveBundledCodexInstallation,
  resolveBundledCodexPath,
  spawnCodexAppServer,
  type AppServerCodexOptions
} from "../src/adapters/codex/app-server.js";
import { CodexProbeCleanupError, verifyCodexInstallation } from "../src/adapters/codex/probe.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(mode = "valid") {
  const directory = await mkdtemp(join(tmpdir(), "tmatrix-codex-probe-"));
  temporaryDirectories.push(directory);
  const executablePath = join(directory, "codex.cjs");
  const trace = join(directory, "trace.jsonl");
  await writeFile(executablePath, `
const fs = require("node:fs");
const readline = require("node:readline");
const trace = (event) => fs.appendFileSync(process.env.PROBE_TRACE, JSON.stringify(event) + "\\n");
const mode = process.env.PROBE_MODE;
trace({ args: process.argv.slice(2), authHome: process.env.CODEX_HOME, home: process.env.HOME,
  apiKey: process.env.OPENAI_API_KEY, path: process.env.PATH });
if ((mode === "version-descendant" && process.argv.includes("--version")) ||
    (mode === "app-descendant" && process.argv.includes("app-server"))) {
  const helper = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  trace({helper: helper.pid});
  helper.unref();
}
if (process.argv.includes("--version")) {
  if (mode === "version-hang") setInterval(() => {}, 1000);
  else if (mode === "version-fail") process.exit(1);
  else if (mode === "version-output") { console.log("private-output".repeat(1000)); }
  else console.log("codex-cli " + (mode === "version-wrong" ? "0.999.0" : "0.158.0"));
} else {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    trace({ method: request.method });
    if (!request.id) return;
    if (mode === request.method + "-hang") return;
    if (mode === request.method + "-fail") {
      console.log(JSON.stringify({id: request.id, error: {code: -1, message: "private-error"}}));
      return;
    }
    if (request.method === "model/list" && mode === "model-invalid-json") {
      console.log("private-invalid-json");
      return;
    }
    let result = {userAgent: "fixture"};
    if (request.method === "model/list") {
      result = mode === "model-empty" ? {data: []}
        : mode === "model-malformed" ? {data: [{id: "invalid", model: " "}]}
        : {data: [{id: "fixture-model", model: "fixture-model"}], nextCursor: null};
    }
    console.log(JSON.stringify({id: request.id, result}));
  });
  lines.on("close", () => process.exit(0));
}
`);
  const environment = {
    HOME: join(directory, "home"),
    CODEX_HOME: join(directory, "auth"),
    OPENAI_API_KEY: "fixture-auth-key",
    PATH: "/fixture/tools",
    PROBE_TRACE: trace,
    PROBE_MODE: mode
  };
  return { directory, executablePath, trace, environment };
}

describe("Codex installation verification", () => {
  it("runs the exact version, initializes and discovers models without creating conversations or changing auth", async () => {
    const candidate = await fixture();
    await verifyCodexInstallation(candidate.executablePath, "0.158.0", candidate.environment);
    const events = (await readFile(candidate.trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event) => event.args)).toEqual([
      { args: ["--version"], authHome: candidate.environment.CODEX_HOME,
        home: candidate.environment.HOME, apiKey: "fixture-auth-key", path: "/fixture/tools" },
      { args: ["--dangerously-bypass-approvals-and-sandbox", "app-server"],
        authHome: candidate.environment.CODEX_HOME, home: candidate.environment.HOME,
        apiKey: "fixture-auth-key", path: "/fixture/tools" }
    ]);
    expect(events.filter((event) => event.method).map((event) => event.method))
      .toEqual(["initialize", "initialized", "model/list"]);
  });

  it.each([
    "version-wrong", "version-fail", "version-output", "initialize-fail",
    "model/list-fail", "model-empty", "model-malformed", "model-invalid-json"
  ])("rejects %s without leaking raw candidate output", async (mode) => {
    const candidate = await fixture(mode);
    const failure = await verifyCodexInstallation(candidate.executablePath, "0.158.0", candidate.environment)
      .then(() => undefined, (cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toMatch(/private-/);
    expect(failure).not.toBeInstanceOf(CodexProbeCleanupError);
  });

  it.each(["version-hang", "initialize-hang", "model/list-hang"])("bounds %s and confirms teardown", async (mode) => {
    const candidate = await fixture(mode);
    const failure = await verifyCodexInstallation(candidate.executablePath, "0.158.0", candidate.environment,
      undefined, { timeoutMs: 150, closeTimeoutMs: 150 })
      .then(() => undefined, (cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CodexProbeCleanupError);
  });

  it("aborts an in-progress probe and closes its process", async () => {
    const candidate = await fixture("model/list-hang");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      await expect(verifyCodexInstallation(candidate.executablePath, "0.158.0", candidate.environment,
        controller.signal)).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
  });

  it("reports uncertain teardown distinctly so staging cannot be deleted", async () => {
    const candidate = await fixture();
    const close = AppServerCodex.prototype.close;
    vi.spyOn(AppServerCodex.prototype, "close").mockImplementationOnce(async function (this: AppServerCodex) {
      await close.call(this);
      throw new Error("receipt unavailable");
    });
    await expect(verifyCodexInstallation(candidate.executablePath, "0.158.0", candidate.environment))
      .rejects.toBeInstanceOf(CodexProbeCleanupError);
  });

  it("does not start a process for an already cancelled check", async () => {
    const candidate = await fixture();
    const signal = AbortSignal.abort();
    await expect(verifyCodexInstallation(candidate.executablePath, "0.158.0", candidate.environment, signal))
      .rejects.toThrow("cancelled");
    await expect(readFile(candidate.trace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32").each(["version-descendant", "app-descendant"])(
    "confirms helper group teardown after the %s root exits with closed stdio", async (mode) => {
      const candidate = await fixture(mode);
      await verifyCodexInstallation(candidate.executablePath, "0.158.0", candidate.environment);
      const events = (await readFile(candidate.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const helper = events.find(event => event.helper)?.helper;
      expect(typeof helper).toBe("number");
      expect(() => process.kill(helper, 0)).toThrow();
    }
  );
});

describe("Codex executable selection", () => {
  it("resolves the bundled native distribution and resources as one installation", () => {
    const installation = resolveBundledCodexInstallation();
    expect(installation.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dirname(dirname(installation.executablePath))).toBe(installation.directory);
    expect(resolveBundledCodexPath()).toBe(installation.executablePath);
  });

  it("captures the selected executable before lazy App Server startup", async () => {
    const selected = await fixture();
    const options: AppServerCodexOptions = {
      executablePath: selected.executablePath,
      environment: selected.environment
    };
    const codex = new AppServerCodex(options);
    options.executablePath = "/unavailable/replacement";
    try {
      await codex.transport();
    } finally {
      await codex.close();
    }
    expect(await readFile(selected.trace, "utf8")).toContain('"method":"initialize"');
  });

  it("launches a native executable directly with the supplied child environment", async () => {
    const child = spawnCodexAppServer(process.execPath, { FIXTURE_MARKER: "preserved" },
      ["-e", "process.stdout.write(process.env.FIXTURE_MARKER)"]);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const result = await new Promise((resolve) => child.once("close", resolve));
    expect(result).toBe(0);
    expect(output).toBe("preserved");
  });

  it("removes inherited package-manager ownership for native updates while preserving authentication", async () => {
    const environment = {
      HOME: "/fixture/home", CODEX_HOME: "/fixture/auth", OPENAI_API_KEY: "fixture-auth",
      CODEX_MANAGED_PACKAGE_ROOT: "/other/npm/package", CODEX_MANAGED_BY_NPM: "1",
      CODEX_MANAGED_BY_BUN: "1", CODEX_MANAGED_BY_PNPM: "1", CODEX_MANAGED_BY_VITE_PLUS: "1"
    };
    const child = spawnCodexAppServer(process.execPath, environment,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"]);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await new Promise((resolve) => child.once("close", resolve));
    const received = JSON.parse(output);
    expect(received).toMatchObject({ HOME: "/fixture/home", CODEX_HOME: "/fixture/auth", OPENAI_API_KEY: "fixture-auth" });
    expect(Object.keys(received).filter(name => name.startsWith("CODEX_MANAGED_"))).toEqual([]);
    expect(environment.CODEX_MANAGED_PACKAGE_ROOT).toBe("/other/npm/package");
  });
});
