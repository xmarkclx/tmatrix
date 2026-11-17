import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api-client.js";
import { projectBannerDirectory } from "../src/helpers/project-banner-directory.js";
import { readProjectBannerCheckpoint } from "../src/helpers/project-banner-checkpoint.js";
import { readProjectBanner } from "../src/helpers/read-project-banner.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { TicketRunner } from "../src/runner.js";
import type { RuntimeLike, RuntimeThreadOptions, WorkerThreadEvent } from "../src/runtime-adapter.js";
import { makeConfig, makeTicket } from "./helpers.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6S8AAAAASUVORK5CYII=", "base64");
const imageUrl = "/api/uploads/images/markdown-images/54/08bbf0a6-54ce-4471-987c-7fe797333aea.png";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function setup(options: { feedback?: boolean; outsidePath?: string; rejectFirstResult?: boolean } = {}) {
  const ticket = makeTicket({ ticket_id: randomUUID(), worker_id: randomUUID(), subject_kind: "project_banner", project_id: randomUUID(), input_revision: 1 });
  const uploads: File[] = [];
  const results: unknown[] = [];
  const runStreamed = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    if (String(input).endsWith("/api/uploads/images/upload")) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-secret-key");
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      expect(init?.redirect).toBe("error");
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);
      if (!(body instanceof FormData)) throw new Error("Expected image form");
      const image = body.get("image");
      if (!(image instanceof File)) throw new Error("Expected image file");
      uploads.push(image);
      return Response.json({ url: imageUrl }, { status: 201 });
    }
    if (String(input).endsWith("/result")) {
      results.push(JSON.parse(String(init?.body)));
      if (options.rejectFirstResult && results.length === 1) return Response.json({}, { status: 400 });
    }
    return Response.json({});
  });
  const runtime: RuntimeLike = {
    startThread(threadOptions: RuntimeThreadOptions) {
      directories.push(threadOptions.workingDirectory);
      return {
        async runStreamed(prompt, turnOptions) {
          runStreamed(prompt, turnOptions);
          expect(prompt).not.toContain("test-secret-key");
          expect(prompt).toContain("then copy the finished PNG");
          expect(turnOptions?.outputSchema).toMatchObject({ required: ["outcome", "context_summary", "user_message", "banner_image_path"] });
          const path = options.outsidePath ?? join(threadOptions.workingDirectory, "banner.png");
          if (!options.outsidePath) await writeFile(path, png);
          const handoff = {
            outcome: options.feedback ? "AI_NEEDS_FEEDBACK" : "AI_DONE",
            context_summary: "Generated the requested project banner.",
            user_message: options.feedback ? "Image generation is unavailable." : "Your banner is ready.",
            banner_image_path: options.feedback ? null : path
          };
          return { events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
            yield { type: "item.completed", item: { id: "banner", type: "agent_message", text: JSON.stringify(handoff) } };
            yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
          })() };
        }
      };
    }
  };
  const api = new ApiClient({ config: makeConfig({ max_request_attempts: 1 }), logger: nullLogger(), metrics: new Metrics(), fetch });
  const runtimeFactory = vi.fn(() => runtime);
  const runner = new TicketRunner({ runtimeFactory, api, logger: nullLogger(), metrics: new Metrics() });
  return { ticket, runner, uploads, results, runStreamed, runtimeFactory };
}

describe("project banner jobs", () => {
  it("transports a generated PNG from the claim directory through multipart upload into the result callback", async () => {
    const { ticket, runner, uploads, results } = setup();
    expect(await runner.run(ticket, { runId: "banner", recovered: false })).toEqual({ status: "completed" });
    expect(uploads).toHaveLength(1);
    expect(Buffer.from(await uploads[0]!.arrayBuffer())).toEqual(png);
    expect(uploads[0]!.type).toBe("image/png");
    expect(results).toEqual([expect.objectContaining({ status: "completed", input_revision: 1, outcome: "AI_DONE", banner_image_url: imageUrl, user_message: "Your banner is ready." })]);
    expect(JSON.stringify(results)).not.toContain("banner_image_path");
    expect(ticket.task_id).toBeUndefined();
  });

  it("recovers a saved upload after a failed result callback without generating or uploading again", async () => {
    const { ticket, runner, uploads, results, runStreamed, runtimeFactory } = setup({ rejectFirstResult: true });
    await expect(runner.run(ticket, { runId: "before-restart", recovered: false })).rejects.toMatchObject({ code: "RESULT_REPORT_FAILED" });
    runtimeFactory.mockImplementation(() => { throw new Error("Runtime is unavailable after restart"); });
    expect(await runner.run(ticket, { runId: "after-restart", recovered: true })).toEqual({ status: "completed" });
    expect(runtimeFactory).toHaveBeenCalledOnce();
    expect(runStreamed).toHaveBeenCalledOnce();
    expect(uploads).toHaveLength(1);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ banner_image_url: imageUrl });
  });

  it("reports unavailable generation without uploading a file", async () => {
    const { ticket, runner, uploads, results } = setup({ feedback: true });
    await runner.run(ticket, { runId: "feedback", recovered: false });
    expect(uploads).toHaveLength(0);
    expect(results[0]).toMatchObject({ status: "completed", outcome: "AI_NEEDS_FEEDBACK" });
    expect(results[0]).not.toHaveProperty("banner_image_url");
  });

  it("rejects an image path outside its claim directory before sending image bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "banner-outside-"));
    directories.push(directory);
    const outsidePath = join(directory, "outside.png");
    await writeFile(outsidePath, png);
    const { ticket, runner, uploads, results } = setup({ outsidePath });
    await runner.run(ticket, { runId: "outside", recovered: false });
    expect(uploads).toHaveLength(0);
    expect(results[0]).toMatchObject({ status: "failed", error: { code: "PROJECT_BANNER_IMAGE_INVALID" } });
  });

  it("rejects text files disguised as a PNG", async () => {
    const directory = await mkdtemp(join(tmpdir(), "banner-invalid-"));
    directories.push(directory);
    const path = join(directory, "image.png");
    await writeFile(path, "private credentials are not image bytes");
    await expect(readProjectBanner(path, directory)).rejects.toMatchObject({ code: "PROJECT_BANNER_IMAGE_INVALID" });
  });

  it("rejects a symlink to an image outside the claim directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "banner-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "banner-symlink-target-"));
    directories.push(directory, outside);
    const target = join(outside, "target.png");
    const link = join(directory, "link.png");
    await writeFile(target, png);
    await symlink(target, link);
    await expect(readProjectBanner(link, directory)).rejects.toMatchObject({ code: "PROJECT_BANNER_IMAGE_INVALID" });
  });

  it("rejects a checkpoint larger than 2 MB", async () => {
    const directory = await mkdtemp(join(tmpdir(), "banner-checkpoint-large-"));
    directories.push(directory);
    await writeFile(join(directory, ".tmatrix-upload.json"), new Uint8Array(2 * 1024 * 1024 + 1));
    await expect(readProjectBannerCheckpoint(directory)).rejects.toMatchObject({ code: "PROJECT_BANNER_CHECKPOINT_INVALID" });
  });

  it.each(["https://other.example.test/image.png", "//other.example.test/image.png", "/api/uploads/images/markdown-images/54/08bbf0a6-54ce-4471-987c-7fe797333aea.png?token=secret", "https://["])(
    "rejects an untrusted upload URL %s", async url => {
      const api = new ApiClient({ config: makeConfig(), logger: nullLogger(), metrics: new Metrics(),
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ url })) });
      await expect(api.uploadProjectBanner({ bytes: new Uint8Array(png), contentType: "image/png", filename: "banner.png" }))
        .rejects.toMatchObject({ code: "PROJECT_BANNER_UPLOAD_INVALID" });
    }
  );

  it("rejects images larger than 10 MB before reading their content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "banner-large-"));
    directories.push(directory);
    const path = join(directory, "large.png");
    await writeFile(path, new Uint8Array(10 * 1024 * 1024 + 1));
    await expect(readProjectBanner(path, directory)).rejects.toMatchObject({ code: "PROJECT_BANNER_IMAGE_INVALID" });
  });

  it("keeps the claim directory stable across recovery and separates concurrent claims", async () => {
    const first = makeTicket({ ticket_id: randomUUID(), worker_id: randomUUID() });
    const firstDirectory = await projectBannerDirectory(first);
    const secondDirectory = await projectBannerDirectory({ ...first, worker_id: randomUUID() });
    directories.push(firstDirectory, secondDirectory);
    expect(await projectBannerDirectory(first)).toBe(firstDirectory);
    expect(secondDirectory).not.toBe(firstDirectory);
  });
});
