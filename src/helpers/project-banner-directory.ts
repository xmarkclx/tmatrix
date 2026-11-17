import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ticket } from "../types.js";

/** Gives each banner claim a private, restart-stable directory for its generated image. */
export async function projectBannerDirectory(ticket: Pick<Ticket, "ticket_id" | "worker_id">): Promise<string> {
  const claim = createHash("sha256").update(JSON.stringify([ticket.ticket_id, ticket.worker_id])).digest("hex");
  const directory = join(tmpdir(), "tmatrix-project-banners", claim);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
