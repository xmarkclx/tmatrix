import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { WorkerError } from "../errors.js";

export interface ProjectBannerImage {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  filename: string;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Reads only a generated image inside this claim's directory, with a bounded allocation. */
export async function readProjectBanner(path: string, directory: string): Promise<ProjectBannerImage> {
  const invalid = () => new WorkerError({
    message: "The banner must be a PNG, JPEG, or WebP image of 10 MB or less inside the banner working directory.",
    code: "PROJECT_BANNER_IMAGE_INVALID", stage: "banner.image"
  });
  if (!isAbsolute(path)) throw invalid();
  const resolved = await realpath(path);
  const withinDirectory = relative(await realpath(directory), resolved);
  if (withinDirectory === "" || withinDirectory === ".." || withinDirectory.startsWith(`..${sep}`) || isAbsolute(withinDirectory)) throw invalid();
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) throw invalid();
    const buffer = new Uint8Array(MAX_IMAGE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === 0 || length > MAX_IMAGE_BYTES) throw invalid();
    const bytes = buffer.slice(0, length);
    const header = Buffer.from(bytes.subarray(0, 12));
    const contentType = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : header[0] === 255 && header[1] === 216 && header[2] === 255 ? "image/jpeg"
      : header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
      : undefined;
    if (!contentType) throw invalid();
    return { bytes, contentType, filename: basename(resolved) };
  } finally {
    await file.close();
  }
}
