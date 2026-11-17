import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WorkerError } from "../errors.js";

const checkpointSchema = z.object({
  handoff: z.object({
    outcome: z.literal("AI_DONE"),
    context_summary: z.string().min(1).max(100_000),
    user_message: z.string().min(1).max(100_000),
    banner_image_path: z.string().min(1).max(4_096)
  }).strict(),
  banner_image_url: z.string().regex(/^\/api\/uploads\/images\/markdown-images\/\d+\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i)
}).strict();

export type ProjectBannerCheckpoint = z.infer<typeof checkpointSchema>;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;

/** Recovers an uploaded image after a daemon restart without generating or uploading it again. */
export async function readProjectBannerCheckpoint(directory: string): Promise<ProjectBannerCheckpoint | undefined> {
  try {
    const file = await open(join(directory, ".tmatrix-upload.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_CHECKPOINT_BYTES) throw new Error("The banner checkpoint is too large.");
      const buffer = Buffer.alloc(MAX_CHECKPOINT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_CHECKPOINT_BYTES) throw new Error("The banner checkpoint is too large.");
      return checkpointSchema.parse(JSON.parse(buffer.toString("utf8", 0, length)));
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw new WorkerError({ message: "The saved banner upload could not be recovered safely.", code: "PROJECT_BANNER_CHECKPOINT_INVALID", stage: "banner.checkpoint", cause });
  }
}

/** Saves the upload receipt atomically before the result callback can be retried. */
export async function writeProjectBannerCheckpoint(directory: string, checkpoint: ProjectBannerCheckpoint): Promise<void> {
  const temporary = join(directory, `.tmatrix-upload-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(checkpointSchema.parse(checkpoint)), { mode: 0o600 });
  await rename(temporary, join(directory, ".tmatrix-upload.json"));
}
