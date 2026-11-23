import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadEngineConfig, safeConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads JSON and applies environment overrides without exposing the API key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiworker-config-"));
    await writeFile(join(directory, "config.json"), JSON.stringify({
      poll_url: "https://tasks.example.test/poll",
      api_key: "file-secret",
      instance_id: "from-file",
      max_workers: 2
    }));

    const config = await loadConfig({
      cwd: directory,
      env: {
        API_KEY: "env-secret",
        INSTANCE_ID: "from-env",
        MAX_WORKERS: "5",
        MAX_TICKETS_PER_POLL: "1",
        CONVERSATION_STATE_DIR: "/private/worker-conversations",
        PRETTY_LOGS: "false"
      }
    });

    expect(config.claude_model).toBe("sonnet");
    expect(config.api_key).toBe("env-secret");
    expect(config.instance_id).toBe("from-env");
    expect(config.max_workers).toBe(5);
    expect(config.max_tickets_per_poll).toBe(1);
    expect(config.conversation_state_dir).toBe("/private/worker-conversations");
    expect(config.pretty_logs).toBe(false);
    expect(safeConfig(config)).not.toHaveProperty("api_key");
    expect(JSON.stringify(safeConfig(config))).not.toContain("env-secret");
  });

  it("rejects an insecure poll URL with a diagnostic code", async () => {
    await expect(loadConfig({
      cwd: tmpdir(),
      env: {
        POLL_URL: "http://tasks.example.test/poll",
        API_KEY: "secret",
        INSTANCE_ID: "instance"
      }
    })).rejects.toMatchObject({
      code: "CONFIG_POLL_URL_INSECURE",
      stage: "config.validate"
    });
  });

  it("accepts only -1 as the unlimited shutdown sentinel", async () => {
    const config = await loadConfig({
      cwd: tmpdir(),
      env: {
        POLL_URL: "https://tasks.example.test/poll",
        API_KEY: "secret",
        INSTANCE_ID: "instance",
        SHUTDOWN_GRACE_MS: "-1"
      }
    });

    expect(config.shutdown_grace_ms).toBe(-1);
    expect(config.max_tickets_per_poll).toBeUndefined();

    await expect(loadConfig({
      cwd: tmpdir(),
      env: {
        POLL_URL: "https://tasks.example.test/poll",
        API_KEY: "secret",
        INSTANCE_ID: "instance",
        SHUTDOWN_GRACE_MS: "-2"
      }
    })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      stage: "config.validate"
    });
  });

  it.each(["0", "-1", "1.5", "101"])("rejects an invalid claim batch size %s", async (batchSize) => {
    await expect(loadConfig({
      cwd: tmpdir(),
      env: {
        POLL_URL: "https://tasks.example.test/poll",
        API_KEY: "secret",
        INSTANCE_ID: "instance",
        MAX_TICKETS_PER_POLL: batchSize
      }
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("Claude model configuration", () => {
  async function configuredModel(model: string) {
    const directory = await mkdtemp(join(tmpdir(), "tmatrix-claude-model-"));
    try {
      await writeFile(join(directory, "config.json"), JSON.stringify({
        update_origin: "https://tasks.example.test", instance_id: "test", sources: [], claude_model: model
      }));
      return (await loadEngineConfig({ cwd: directory, env: {} })).claude_model;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it.each(["opus", "sonnet", "haiku", "fable", "opus[1m]", "claude-opus-4-8", "claude-sonnet-4-6[1m]"])(
    "loads the Claude default %s", async model => {
      await expect(configuredModel(model)).resolves.toBe(model);
    }
  );

  it.each(["--help", "gpt-6-sol", "opus --help", " opus", "claude-", "opus[2m]", "opus\n"])(
    "rejects an invalid Claude default %j", async model => {
      await expect(configuredModel(model)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  );
});
