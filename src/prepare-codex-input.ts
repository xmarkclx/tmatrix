import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Input, UserInput } from "./runtime-adapter.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_INPUTS = 12;
const MARKDOWN_IMAGE_PATTERN = /!\[(?:\\.|[^\]])*\]\(\s*<?([^\s)>]+)/g;
const UPLOADED_IMAGE_PATH_PATTERN =
  /^\/api\/uploads\/images\/markdown-images\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:gif|jpg|png|webp)$/i;
const EXTENSION_BY_CONTENT_TYPE = new Map([
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"]
]);

export interface PreparedCodexInput {
  input: Input;
  attachedImages: number;
  skippedImages: number;
  cleanup(): Promise<void>;
}

interface PrepareCodexInputOptions {
  origin: string;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/** Downloads trusted Tzu Do Markdown images for one Codex turn. */
export async function prepareCodexInput(
  text: string,
  options: PrepareCodexInputOptions
): Promise<PreparedCodexInput> {
  const origin = new URL(options.origin).origin;
  const urls = [...text.matchAll(MARKDOWN_IMAGE_PATTERN)]
    .flatMap((match) => match[1] ? [match[1]] : [])
    .map((candidate) => {
      try {
        const url = new URL(candidate, origin);
        return url.origin === origin &&
          !url.search &&
          !url.hash &&
          UPLOADED_IMAGE_PATH_PATTERN.test(url.pathname)
          ? url
          : null;
      } catch {
        return null;
      }
    })
    .filter((url): url is URL => url !== null)
    .filter((url, index, all) =>
      all.findIndex((candidate) => candidate.href === url.href) === index
    )
    .slice(0, MAX_IMAGE_INPUTS);

  if (urls.length === 0) return emptyPreparedInput(text);

  const directory = await mkdtemp(join(tmpdir(), "tzu-do-codex-images-"));
  const entries: UserInput[] = [{ type: "text", text }];
  let skippedImages = 0;

  for (const [index, url] of urls.entries()) {
    try {
      const response = await options.fetch(url, {
        redirect: "error",
        ...(options.signal ? { signal: options.signal } : {})
      });
      const contentType = response.headers.get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      const extension = contentType
        ? EXTENSION_BY_CONTENT_TYPE.get(contentType)
        : undefined;
      const contentLength = Number(response.headers.get("content-length"));
      if (
        !response.ok ||
        !extension ||
        (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES)
      ) {
        skippedImages += 1;
        continue;
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        skippedImages += 1;
        continue;
      }

      const path = join(directory, `image-${index + 1}.${extension}`);
      await writeFile(path, bytes, { mode: 0o600 });
      entries.push({ type: "local_image", path });
    } catch (cause) {
      if (options.signal?.aborted) {
        await rm(directory, { recursive: true, force: true });
        throw cause;
      }
      skippedImages += 1;
    }
  }

  const attachedImages = entries.length - 1;
  if (attachedImages === 0) {
    await rm(directory, { recursive: true, force: true });
    return {
      ...emptyPreparedInput(text),
      skippedImages
    };
  }

  return {
    input: entries,
    attachedImages,
    skippedImages,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

/** Avoids array input and temporary files when a turn has no usable images. */
function emptyPreparedInput(text: string): PreparedCodexInput {
  return {
    input: text,
    attachedImages: 0,
    skippedImages: 0,
    cleanup: async () => undefined
  };
}
