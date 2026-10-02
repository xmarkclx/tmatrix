import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const REGISTRY = "https://registry.npmjs.org";
const METADATA_LIMIT = 1024 * 1024;
const DOWNLOAD_LIMIT = 512 * 1024 * 1024;
const EXTRACT_LIMIT = 1024 * 1024 * 1024;

export interface CodexRelease {
  version: string;
  packageName: string;
  packageVersion: string;
  targetTriple: string;
  tarballUrl: string;
  integrity: string;
}

export function isStableCodexVersion(version: unknown): version is string {
  return typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
}

export function codexPlatform(platform: string = process.platform, arch: string = process.arch) {
  const machine = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : undefined;
  const system = { linux: "unknown-linux-musl", darwin: "apple-darwin", win32: "pc-windows-msvc" }[platform];
  if (!machine || !system) throw new Error("Codex updates are unsupported on this platform");
  return {
    packageName: `@openai/codex-${platform}-${arch}`,
    suffix: `${platform}-${arch}`,
    targetTriple: `${machine}-${system}`,
    executable: platform === "win32" ? "codex.exe" : "codex"
  };
}

function deadline(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function registryUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== REGISTRY || url.username || url.password || url.search || url.hash) {
    throw new Error("Codex update URL is outside the official registry");
  }
  return url;
}

async function response(url: string, signal: AbortSignal): Promise<Response> {
  const result = await fetch(registryUrl(url), { signal, redirect: "error" });
  if (!result.ok || !result.body) {
    await result.body?.cancel();
    throw new Error("Codex registry request failed");
  }
  return result;
}

async function* limitedBody(result: Response, limit: number, signal: AbortSignal) {
  const reader = result.body!.getReader();
  let size = 0;
  try {
    const declared = result.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
      throw new Error("Codex registry response exceeds its size limit");
    }
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) return;
      size += value.length;
      if (size > limit) throw new Error("Codex registry response exceeds its size limit");
      yield Buffer.from(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function metadata(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of limitedBody(await response(`${REGISTRY}/${path}`, signal), METADATA_LIMIT, signal)) {
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex registry metadata");
  return value as Record<string, unknown>;
}

function integrityDigest(integrity: string): Buffer {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error("Codex release has no valid SHA-512 integrity");
  const digest = Buffer.from(integrity.slice(7), "base64");
  if (digest.length !== 64 || `sha512-${digest.toString("base64")}` !== integrity) {
    throw new Error("Codex release has no valid SHA-512 integrity");
  }
  return digest;
}

/** Resolve the stable CLI tag, then the exact native package named by that release. */
export async function latestStableCodexRelease(signal?: AbortSignal): Promise<CodexRelease> {
  const bounded = deadline(signal, 30_000);
  const target = codexPlatform();
  const latest = await metadata("@openai/codex/latest", bounded);
  if (latest.name !== "@openai/codex" || !isStableCodexVersion(latest.version)) {
    throw new Error("Codex latest tag does not identify a stable release");
  }
  const dependencies = latest.optionalDependencies as Record<string, unknown> | undefined;
  const specification = dependencies?.[target.packageName];
  // Current OpenAI packages use an npm alias. Also support an exact-version
  // native package, without accepting arbitrary registries, tags or ranges.
  const aliasVersion = `${latest.version}-${target.suffix}`;
  const packageName = specification === `npm:@openai/codex@${aliasVersion}` ? "@openai/codex" : target.packageName;
  const packageVersion = packageName === "@openai/codex" ? aliasVersion : latest.version;
  if (specification !== `npm:@openai/codex@${aliasVersion}` && specification !== latest.version) {
    throw new Error("Codex release has no exact package for this platform");
  }
  const native = await metadata(`${packageName}/${packageVersion}`, bounded);
  const dist = native.dist as Record<string, unknown> | undefined;
  if (native.name !== packageName || native.version !== packageVersion ||
      typeof dist?.tarball !== "string" || typeof dist.integrity !== "string") {
    throw new Error("Invalid Codex native package metadata");
  }
  const url = registryUrl(dist.tarball);
  if (!url.pathname.startsWith(`/${packageName}/-/`) || !url.pathname.endsWith(".tgz")) {
    throw new Error("Unexpected Codex package archive URL");
  }
  integrityDigest(dist.integrity);
  return {
    version: latest.version, packageName, packageVersion, targetTriple: target.targetTriple,
    tarballUrl: url.href, integrity: dist.integrity
  };
}

async function writeAll(file: FileHandle, value: Buffer): Promise<void> {
  let offset = 0;
  while (offset < value.length) {
    const { bytesWritten } = await file.write(value, offset, value.length - offset);
    if (bytesWritten === 0) throw new Error("Could not write Codex release file");
    offset += bytesWritten;
  }
}

function tarText(block: Buffer, start: number, size: number): string {
  const field = block.subarray(start, start + size);
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString("utf8");
}

function tarNumber(block: Buffer, start: number, size: number): number {
  const value = tarText(block, start, size).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Invalid Codex archive number");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error("Invalid Codex archive number");
  return number;
}

/** Only ordinary USTAR files/directories are accepted. No links, devices or extensions. */
async function extractArchive(archive: string, directory: string, signal: AbortSignal): Promise<void> {
  let file: FileHandle | undefined;
  let remaining = 0;
  let padding = 0;
  let header: Buffer = Buffer.alloc(0);
  let total = 0;
  let entries = 0;
  let ended = false;
  let zeroBlocks = 0;
  const seen = new Set<string>();
  try {
    await pipeline(createReadStream(archive), createGunzip(), async (source) => {
      for await (const raw of source) {
        signal.throwIfAborted();
        let chunk = Buffer.from(raw as Uint8Array);
        total += chunk.length;
        if (total > EXTRACT_LIMIT) throw new Error("Codex archive exceeds its extraction limit");
        while (chunk.length > 0) {
          signal.throwIfAborted();
          if (remaining > 0) {
            const count = Math.min(remaining, chunk.length);
            if (file) await writeAll(file, chunk.subarray(0, count));
            remaining -= count;
            chunk = chunk.subarray(count);
            if (remaining === 0 && file) { await file.close(); file = undefined; }
          } else if (padding > 0) {
            const count = Math.min(padding, chunk.length);
            padding -= count;
            chunk = chunk.subarray(count);
          } else {
            const count = Math.min(512 - header.length, chunk.length);
            header = Buffer.concat([header, chunk.subarray(0, count)]);
            chunk = chunk.subarray(count);
            if (header.length < 512) continue;
            const block = header;
            header = Buffer.alloc(0);
            if (block.every((byte) => byte === 0)) { ended = true; zeroBlocks++; continue; }
            if (ended) throw new Error("Unexpected data after Codex archive end");
            if (++entries > 4096) throw new Error("Codex archive has too many entries");
            let checksum = 0;
            for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : block[i]!;
            if (checksum !== tarNumber(block, 148, 8) || tarText(block, 257, 6) !== "ustar") {
              throw new Error("Invalid Codex archive header");
            }
            const type = block[156];
            if (type !== 0 && type !== 48 && type !== 53) throw new Error("Unsupported Codex archive entry");
            const prefix = tarText(block, 345, 155);
            const path = `${prefix ? `${prefix}/` : ""}${tarText(block, 0, 100)}`.replace(/\/$/, "");
            const parts = path.split("/");
            if (parts[0] !== "package" || parts.some((part) =>
              !part || part === "." || part === ".." || /[\\:<>"|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) ||
              /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
              throw new Error("Unsafe Codex archive path");
            }
            if (seen.has(path)) throw new Error("Duplicate Codex archive entry");
            seen.add(path);
            const destination = join(directory, ...parts);
            remaining = tarNumber(block, 124, 12);
            if (remaining > EXTRACT_LIMIT || total + remaining > EXTRACT_LIMIT) throw new Error("Codex archive exceeds its extraction limit");
            padding = (512 - remaining % 512) % 512;
            if (type === 53) {
              if (remaining !== 0) throw new Error("Invalid Codex archive directory");
              await mkdir(destination, { recursive: true, mode: 0o700 });
            } else {
              await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
              // Strip special bits and group/world writes, but preserve helper executability.
              const mode = tarNumber(block, 100, 8) & 0o111 ? 0o755 : 0o644;
              file = await open(destination, "wx", mode);
              if (remaining === 0) { await file.close(); file = undefined; }
            }
          }
        }
      }
      if (remaining || padding || header.length || zeroBlocks < 2) throw new Error("Truncated Codex archive");
    }, { signal });
  } finally {
    await file?.close();
  }
}

/** Install into a caller-owned empty candidate directory; activation is a separate step. */
export async function installCodexRelease(release: CodexRelease, directory: string, signal?: AbortSignal): Promise<string> {
  const bounded = deadline(signal, 5 * 60_000);
  const target = codexPlatform();
  if (!isStableCodexVersion(release.version) || release.targetTriple !== target.targetTriple) {
    throw new Error("Invalid Codex release target");
  }
  const expectedDigest = integrityDigest(release.integrity);
  registryUrl(release.tarballUrl);
  // The version manager supplies a fresh mkdtemp directory. Never overlay an
  // existing installation, including paths that might contain symlinks.
  if (!(await lstat(directory)).isDirectory() || (await readdir(directory)).length !== 0) {
    throw new Error("Codex candidate directory is not empty or is not a real directory");
  }
  const archive = join(directory, ".download.tgz");
  try {
    const download = await open(archive, "wx", 0o600);
    const hash = createHash("sha512");
    try {
      for await (const chunk of limitedBody(await response(release.tarballUrl, bounded), DOWNLOAD_LIMIT, bounded)) {
        hash.update(chunk);
        await writeAll(download, chunk);
      }
    } finally {
      await download.close();
    }
    if (!timingSafeEqual(hash.digest(), expectedDigest)) throw new Error("Codex archive integrity verification failed");
    await extractArchive(archive, directory, bounded);
    const packagePath = join(directory, "package", "package.json");
    if ((await stat(packagePath)).size > METADATA_LIMIT) throw new Error("Invalid Codex package manifest");
    const manifest: unknown = JSON.parse(await readFile(packagePath, "utf8"));
    if (!manifest || typeof manifest !== "object" || !("name" in manifest) || !("version" in manifest) ||
        manifest.name !== release.packageName || manifest.version !== release.packageVersion) {
      throw new Error("Codex archive package identity does not match the release");
    }
    const executable = resolve(directory, "package", "vendor", target.targetTriple, "bin", target.executable);
    if (!(await stat(executable)).isFile()) throw new Error("Codex release executable is missing");
    bounded.throwIfAborted();
    return executable;
  } finally {
    await rm(archive, { force: true });
  }
}
