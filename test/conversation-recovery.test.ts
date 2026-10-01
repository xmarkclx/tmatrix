import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { LEASE_ENV, legacyLockPredatesBoot, stopLeaseProcesses } from "../src/conversation-recovery.js";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), readFile: vi.fn(), readdir: vi.fn(), stat: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe.skipIf(process.platform !== "linux")("legacy reboot recovery", () => {
  function setup(overrides = {}) {
    vi.spyOn(Date, "now").mockReturnValue(1_100_000);
    vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => true, birthtimeMs: 800_000, ctimeMs: 800_000, ...overrides } as never);
    vi.mocked(fs.readFile).mockImplementation(async (path) => path === "/proc/stat" ? "btime 1000\n" : "100.00 100.00\n" as never);
  }
  it("recognizes an unchanged legacy inode from before boot", async () => {
    setup();
    expect(await legacyLockPredatesBoot("lock")).toBe(true);
  });
  it.each([{ birthtimeMs: 0 }, { birthtimeMs: 1_050_000 }, { ctimeMs: 1_050_000 }, { isSymbolicLink: () => false }])("rejects ambiguous or current-boot metadata %j", async (changes) => {
    setup(changes);
    expect(await legacyLockPredatesBoot("lock")).toBe(false);
  });
  it("rejects inconsistent clocks and unreadable boot information", async () => {
    setup();
    vi.mocked(Date.now).mockReturnValue(2_000_000);
    expect(await legacyLockPredatesBoot("lock")).toBe(false);
    vi.mocked(fs.readFile).mockRejectedValue(new Error("unavailable"));
    expect(await legacyLockPredatesBoot("lock")).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("lease process cleanup", () => {
  function setup() {
    vi.mocked(fs.readdir).mockResolvedValue(["987654", "987655"] as never);
    vi.mocked(fs.stat).mockResolvedValue({ uid: process.getuid!() } as never);
    const processStat = (pid: string, start: string) => `${pid} (fictional worker) S ${Array(18).fill("0").join(" ")} ${start} 0`;
    vi.mocked(fs.readFile).mockImplementation(async (path) => {
      const name = String(path);
      if (name.endsWith("/stat")) return processStat(name.split("/")[2]!, "42") as never;
      return Buffer.from(`${LEASE_ENV}=${name.includes("987654") ? "target-token" : "other-token"}\0PRIVATE=value-not-logged\0`) as never;
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      vi.mocked(fs.readdir).mockResolvedValue(["987655"] as never);
      return true;
    });
    return { kill, processStat };
  }
  it("signals only the exact lease and verifies it has disappeared", async () => {
    const { kill } = setup();
    expect(await stopLeaseProcesses("target-token")).toBe(true);
    expect(kill).toHaveBeenCalledExactlyOnceWith(987654, "SIGTERM");
  });
  it("does not signal a reused PID", async () => {
    const { kill, processStat } = setup();
    const read = vi.mocked(fs.readFile).getMockImplementation()!;
    let calls = 0;
    vi.mocked(fs.readFile).mockImplementation(async (...args) => {
      if (String(args[0]) === "/proc/987654/stat" && ++calls >= 3) {
        vi.mocked(fs.readdir).mockResolvedValue(["987655"] as never);
        return processStat("987654", "99") as never;
      }
      return read(...args);
    });
    expect(await stopLeaseProcesses("target-token")).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });
  it("refuses recovery if process inspection or signalling is denied", async () => {
    const { kill } = setup();
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    expect(await stopLeaseProcesses("target-token")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    setup().kill.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(await stopLeaseProcesses("target-token")).toBe(false);
  });
  it("tolerates an environ read racing process exit, without ignoring live denied processes", async () => {
    const { kill, processStat } = setup();
    const read = vi.mocked(fs.readFile).getMockImplementation()!;
    let exited = false;
    vi.mocked(fs.readFile).mockImplementation(async (...args) => {
      if (String(args[0]) === "/proc/987654/environ") {
        exited = true;
        throw Object.assign(new Error("exiting"), { code: "EACCES" });
      }
      if (String(args[0]) === "/proc/987654/stat" && exited) return processStat("987654", "42").replace(") S ", ") Z ") as never;
      return read(...args);
    });
    expect(await stopLeaseProcesses("target-token")).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it("honors cancellation before touching any process", async () => {
    const { kill } = setup();
    await expect(stopLeaseProcesses("target-token", AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
    expect(kill).not.toHaveBeenCalled();
  });
});
