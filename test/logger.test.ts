import { access, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { makeConfig } from "./helpers.js";

describe("createLogger", () => {
  it("writes structured logs to an application-managed rotating file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiworker-logs-"));
    const { logger, close } = createLogger(makeConfig({
      log_level: "info",
      log_dir: directory,
      log_rotate_size: "1M",
      log_rotate_interval: "1d",
      log_max_files: 2
    }));

    logger.info({ event: "test.event", api_key: "must-not-appear" }, "test log");
    await close();

    await access(join(directory, "aiworker.log"));
    const files = await readdir(directory);
    expect(files).toContain("aiworker.log");
    expect(files.filter((name) => name.endsWith(".gz"))).toEqual([]);
  });

  it("rotates and compresses logs without recursively logging rotation events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiworker-rotation-"));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { logger, close } = createLogger(makeConfig({
      log_level: "info",
      log_dir: directory,
      log_rotate_size: "64K",
      log_rotate_interval: "1d",
      log_max_files: 3
    }));

    logger.info({ event: "test.large_event", content: "x".repeat(70_000) }, "large test log");
    logger.info({ event: "test.after_rotation" }, "post-rotation log");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await close();
    stdout.mockRestore();

    const files = await readdir(directory);
    expect(files.some((name) => name.endsWith(".gz"))).toBe(true);
    expect(files).toContain("aiworker.log");
  });
});
