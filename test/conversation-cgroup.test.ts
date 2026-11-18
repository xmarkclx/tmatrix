import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { createLeaseCgroup, stopLeaseCgroup, validLeaseCgroup } from "../src/conversation-cgroup.js";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(), mkdir: vi.fn(), readFile: vi.fn(), readdir: vi.fn(),
  realpath: vi.fn(), rmdir: vi.fn(), statfs: vi.fn(), writeFile: vi.fn()
}));
const token = "12345678-1234-1234-1234-123456789abc";
const path = `/sys/fs/cgroup/example.service/tmatrix-lease-${token}`;
const failure = (code: string) => Object.assign(new Error(code), { code });

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
beforeEach(() => {
  vi.mocked(fs.statfs).mockResolvedValue({ type: 0x63677270 } as never);
  vi.mocked(fs.realpath).mockImplementation(async value => String(value));
  vi.mocked(fs.readFile).mockResolvedValue("0::/example.service\n");
  vi.mocked(fs.readdir).mockResolvedValue([]);
});

describe.skipIf(process.platform !== "linux")("conversation cgroup ownership", () => {
  it("allocates an isolated writable cgroup before advertising tracking", async () => {
    expect(await createLeaseCgroup(token)).toBe(path);
    expect(fs.mkdir).toHaveBeenCalledWith(path);
    expect(fs.access).toHaveBeenCalledWith(`${path}/cgroup.kill`, expect.any(Number));
  });

  it("falls back and removes its allocation when kernel kill support is unavailable", async () => {
    vi.mocked(fs.access).mockRejectedValue(failure("ENOENT"));
    expect(await createLeaseCgroup(token)).toBeUndefined();
    expect(fs.rmdir).toHaveBeenCalledWith(path);
  });

  it("does not remove an existing group it failed to allocate", async () => {
    vi.mocked(fs.mkdir).mockRejectedValue(failure("EEXIST"));
    expect(await createLeaseCgroup(token)).toBeUndefined();
    expect(fs.rmdir).not.toHaveBeenCalled();
  });

  it.each(["/tmp/tmatrix-lease-" + token, path + "/../" + path.split("/").at(-1), path + "/", path.replace(token, "other"), "/sys/fs/cgroup"])("rejects an untrusted group path %s", async invalid => {
    expect(validLeaseCgroup(invalid, token)).toBe(false);
    expect(await stopLeaseCgroup(invalid, token)).toBe(false);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("requires the kernel cgroup filesystem", async () => {
    vi.mocked(fs.statfs).mockResolvedValue({ type: 0 } as never);
    expect(await stopLeaseCgroup(path, token)).toBe(false);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("rejects redirected paths without signalling anything", async () => {
    vi.mocked(fs.realpath).mockResolvedValue("/sys/fs/cgroup/another.service");
    expect(await stopLeaseCgroup(path, token)).toBe(false);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("kills and removes descendants before removing their parent", async () => {
    vi.mocked(fs.readdir).mockResolvedValueOnce([{ name: "nested", isDirectory: () => true }] as never).mockResolvedValueOnce([]);
    expect(await stopLeaseCgroup(path, token)).toBe(true);
    expect(fs.writeFile).toHaveBeenCalledWith(`${path}/cgroup.kill`, "1");
    expect(vi.mocked(fs.rmdir).mock.calls).toEqual([[`${path}/nested`], [path]]);
  });

  it("repeats kill when a late entrant prevents removal", async () => {
    vi.mocked(fs.rmdir).mockRejectedValueOnce(failure("EBUSY"));
    expect(await stopLeaseCgroup(path, token)).toBe(true);
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
  });

  it("does not report an empty group as stopped when removal is denied", async () => {
    vi.mocked(fs.rmdir).mockRejectedValue(failure("EACCES"));
    expect(await stopLeaseCgroup(path, token)).toBe(false);
  });

  it("accepts an already removed group", async () => {
    vi.mocked(fs.realpath).mockRejectedValue(failure("ENOENT"));
    expect(await stopLeaseCgroup(path, token)).toBe(true);
  });

  it("does not mistake a missing kill control for a removed group", async () => {
    vi.mocked(fs.writeFile).mockRejectedValue(failure("ENOENT"));
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(6000);
    expect(await stopLeaseCgroup(path, token)).toBe(false);
    expect(fs.rmdir).not.toHaveBeenCalled();
  });
});
