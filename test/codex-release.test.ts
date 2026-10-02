import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexPlatform, installCodexRelease, isStableCodexVersion, latestStableCodexRelease, type CodexRelease
} from "../src/codex-release.js";

const target = codexPlatform();
const version = "1.2.3";
const packageVersion = `${version}-${target.suffix}`;
const packageManifest = { name: "@openai/codex", version: packageVersion };
const tarballUrl = `https://registry.npmjs.org/@openai/codex/-/codex-${packageVersion}.tgz`;
const temporary: string[] = [];

type Entry = { path: string; content?: string; type?: string; mode?: number };

function tar(entries: Entry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const { path, content = "", type = "0", mode = 0o755 } of entries) {
    const header = Buffer.alloc(512);
    const body = Buffer.from(content);
    if (path.length > 100) {
      const split = path.lastIndexOf("/");
      header.write(path.slice(0, split), 345, 155);
      header.write(path.slice(split + 1), 0, 100);
    } else header.write(path, 0, 100);
    header.write(mode.toString(8).padStart(7, "0"), 100, 8);
    header.write(body.length.toString(8).padStart(11, "0"), 124, 12);
    header.fill(32, 148, 156);
    header.write(type, 156, 1);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function validEntries(): Entry[] {
  return [
    { path: "package/package.json", content: JSON.stringify(packageManifest), mode: 0o644 },
    { path: `package/vendor/${target.targetTriple}/bin/${target.executable}`, content: "CLI" },
    { path: `package/vendor/${target.targetTriple}/codex-path/rg`, content: "search helper" },
    { path: `package/vendor/${target.targetTriple}/codex-resources/voice/lib/gstreamer-1.0/libgstapp.so`, content: "library", mode: 0o644 }
  ];
}

function release(archive: Buffer): CodexRelease {
  return {
    version, packageName: "@openai/codex", packageVersion, targetTriple: target.targetTriple,
    tarballUrl, integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`
  };
}

function mockDownload(archive: Buffer) {
  const fetchMock = vi.fn(async () => new Response(new Uint8Array(archive)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function candidate(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tmatrix-codex-release-"));
  temporary.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("stable Codex release resolution", () => {
  it("resolves only the exact platform package associated with the stable latest tag", async () => {
    const archive = gzipSync(tar(validEntries()));
    const expected = release(archive);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        name: "@openai/codex", version,
        optionalDependencies: { [target.packageName]: `npm:@openai/codex@${packageVersion}` }
      }))
      .mockResolvedValueOnce(Response.json({ ...packageManifest, dist: { tarball: tarballUrl, integrity: expected.integrity } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(latestStableCodexRelease()).resolves.toEqual(expected);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://registry.npmjs.org/@openai/codex/latest", `https://registry.npmjs.org/@openai/codex/${packageVersion}`
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it.each(["1.2.3-beta.1", "1.2.3-alpha", "1.2.3+local", "v1.2.3", "01.2.3", "latest"])("rejects non-stable tag %s", async (invalid) => {
    const fetchMock = vi.fn(async () => Response.json({ name: "@openai/codex", version: invalid }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(latestStableCodexRelease()).rejects.toThrow("stable release");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses dependency ranges or foreign aliases", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      name: "@openai/codex", version, optionalDependencies: { [target.packageName]: "npm:foreign-package@1.2.3" }
    })));
    await expect(latestStableCodexRelease()).rejects.toThrow("exact package");
  });

  it.each([
    { tarball: "https://example.com/codex.tgz", integrity: `sha512-${Buffer.alloc(64).toString("base64")}` },
    { tarball: tarballUrl, integrity: "sha1-abcdef" }
  ])("refuses an untrusted archive location or weak/missing integrity", async (dist) => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({
        name: "@openai/codex", version, optionalDependencies: { [target.packageName]: `npm:@openai/codex@${packageVersion}` }
      }))
      .mockResolvedValueOnce(Response.json({ ...packageManifest, dist })));
    await expect(latestStableCodexRelease()).rejects.toThrow();
  });

  it("bounds metadata response size and cancels the body", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(2 * 1024 * 1024) }
    })));
    await expect(latestStableCodexRelease()).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("maps all supported release platforms and rejects unsupported hosts", () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      for (const arch of ["x64", "arm64"]) {
        expect(codexPlatform(platform, arch).packageName).toBe(`@openai/codex-${platform}-${arch}`);
      }
    }
    expect(codexPlatform("darwin", "arm64").targetTriple).toBe("aarch64-apple-darwin");
    expect(codexPlatform("win32", "x64").executable).toBe("codex.exe");
    expect(() => codexPlatform("linux", "ia32")).toThrow("unsupported");
    expect(() => codexPlatform("freebsd", "x64")).toThrow("unsupported");
    expect(isStableCodexVersion("0.158.0")).toBe(true);
  });
});

describe("isolated Codex release installation", () => {
  it("verifies and extracts the native CLI plus helper/resource files including long USTAR paths", async () => {
    const archive = gzipSync(tar(validEntries()));
    mockDownload(archive);
    const directory = await candidate();
    const executable = await installCodexRelease(release(archive), directory);
    expect(await readFile(executable, "utf8")).toBe("CLI");
    expect(await readFile(join(directory, validEntries()[2]!.path), "utf8")).toBe("search helper");
    expect(await readFile(join(directory, validEntries()[3]!.path), "utf8")).toBe("library");
    if (process.platform !== "win32") {
      expect((await stat(executable)).mode & 0o777).toBe(0o755 & ~process.umask());
      expect((await stat(join(directory, "package/package.json"))).mode & 0o777).toBe(0o644 & ~process.umask());
    }
    expect(await readdir(directory)).toEqual(["package"]);
  });

  it("checks the digest before extracting anything", async () => {
    const archive = gzipSync(tar(validEntries()));
    mockDownload(Buffer.from("tampered"));
    const directory = await candidate();
    await expect(installCodexRelease(release(archive), directory)).rejects.toThrow("integrity");
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    { path: "package/../../escape", type: "0" },
    { path: "/package/escape", type: "0" },
    { path: "package/..\\escape", type: "0" },
    { path: "package/C:escape", type: "0" },
    { path: "package/NUL", type: "0" },
    { path: "package/com1.txt", type: "0" },
    { path: "package/aliased-name.", type: "0" },
    { path: "package/link", type: "2" },
    { path: "package/hardlink", type: "1" },
    { path: "package/pax", type: "x" }
  ])("rejects unsafe archive entry $path ($type)", async (entry) => {
    const archive = gzipSync(tar([entry, ...validEntries()]));
    mockDownload(archive);
    await expect(installCodexRelease(release(archive), await candidate())).rejects.toThrow(/Unsafe|Unsupported/);
  });

  it("rejects duplicate files and corrupt/truncated headers", async () => {
    const duplicate = gzipSync(tar([validEntries()[0]!, ...validEntries()]));
    mockDownload(duplicate);
    await expect(installCodexRelease(release(duplicate), await candidate())).rejects.toThrow("Duplicate");
    const damaged = tar(validEntries());
    damaged[10] = 88;
    const archive = gzipSync(damaged);
    mockDownload(archive);
    await expect(installCodexRelease(release(archive), await candidate())).rejects.toThrow("header");
    const truncated = gzipSync(tar(validEntries()).subarray(0, 800));
    mockDownload(truncated);
    await expect(installCodexRelease(release(truncated), await candidate())).rejects.toThrow("Truncated");
  });

  it("rejects an archive whose manifest differs from registry metadata", async () => {
    const entries = validEntries();
    entries[0]!.content = JSON.stringify({ ...packageManifest, version: "8.8.8" });
    const archive = gzipSync(tar(entries));
    mockDownload(archive);
    await expect(installCodexRelease(release(archive), await candidate())).rejects.toThrow("identity");
  });

  it("refuses to overlay a nonempty version directory", async () => {
    const archive = gzipSync(tar(validEntries()));
    const fetchMock = mockDownload(archive);
    const directory = await candidate();
    await writeFile(join(directory, "existing-worker"), "untouched");
    await expect(installCodexRelease(release(archive), directory)).rejects.toThrow("not empty");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(join(directory, "existing-worker"), "utf8")).toBe("untouched");
  });

  it("passes cancellation to requests and removes the partial download", async () => {
    const archive = gzipSync(tar(validEntries()));
    const abort = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url, options: RequestInit) => {
      abort.abort();
      options.signal!.throwIfAborted();
      return new Response(archive);
    }));
    const directory = await candidate();
    await expect(installCodexRelease(release(archive), directory, abort.signal)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it("bounds compressed downloads before writing response bytes", async () => {
    const archive = gzipSync(tar(validEntries()));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(archive, {
      headers: { "content-length": String(600 * 1024 * 1024) }
    })));
    const directory = await candidate();
    await expect(installCodexRelease(release(archive), directory)).rejects.toThrow("size limit");
    expect(await readdir(directory)).toEqual([]);
  });
});
