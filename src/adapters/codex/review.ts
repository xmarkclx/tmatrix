import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, AdapterReviewRequest } from "../../runtime-adapter.js";
import { AppServerCodex, type AppServerSpawner } from "./app-server.js";
import type { CodexExecutableLease } from "./update-manager.js";

// Prevent host hooks/integrations from loading before the review thread exists.
const REVIEW_FEATURES = ["apps", "enable_mcp_apps", "browser_use", "browser_use_external", "computer_use", "code_mode", "code_mode_host", "code_mode_only",
  "multi_agent", "multi_agent_v2", "goals", "hooks", "memories", "remote_plugin", "plugins", "shell_tool", "unified_exec", "shell_snapshot",
  "view_image", "image_generation", "skill_search", "skill_mcp_dependency_install", "tool_suggest", "sleep_tool",
  "default_mode_request_user_input", "request_permissions_tool", "auth_elicitation", "workspace_dependencies"];

/** Reuse provider login/version while withholding tools and all executing conversation state. */
export async function reviewCodexPrompt(options: {
  context: AdapterContext;
  request: AdapterReviewRequest;
  lease?: CodexExecutableLease;
  /** Fake transport for protocol tests; production always launches the selected Codex binary. */
  spawnProcess?: AppServerSpawner;
}): Promise<unknown> {
  let directory: string | undefined;
  let runtime: AppServerCodex | undefined;
  let stopped = false;
  try {
    directory = await mkdtemp(join(tmpdir(), "tmatrix-review-"));
    const catalog = join(directory, "review-model.json");
    // Only the selected model's identifier/effort is reused. This local descriptor
    // deliberately advertises no coding tools, experimental tools or instruction template.
    await writeFile(catalog, JSON.stringify({ models: [{
      slug: options.request.profile.model, display_name: options.request.profile.model,
      base_instructions: options.request.instructions, shell_type: "disabled", apply_patch_tool_type: null,
      experimental_supported_tools: [], tool_mode: "default", visibility: "list", supported_in_api: true,
      priority: 0, support_verbosity: false,
      supported_reasoning_levels: [{ effort: options.request.profile.reasoning_effort, description: "Worker selection" }],
      truncation_policy: { mode: "tokens", limit: 10000 },
    }] }), { mode: 0o600 });
    const arguments_ = ["app-server", "-c", `model_catalog_json=${JSON.stringify(catalog)}`,
      "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0",
      "-c", "tools.experimental_request_user_input.enabled=false", "-c", "tools.update_plan.enabled=false",
      "-c", "skills.include_instructions=false", "-c", "include_environment_context=false",
      "-c", "features.skip_host_skill_discovery=true",
      ...REVIEW_FEATURES.flatMap(feature => ["-c", `features.${feature}=false`])];
    runtime = new AppServerCodex({
      environment: options.context.environment, reviewArguments: arguments_, workingDirectory: directory,
      ...(options.lease ? { executablePath: options.lease.executablePath } : {}),
      ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
      // Review input and classifier output must never enter raw protocol diagnostics.
    });
    const turn = await runtime.reviewThread(options.request, directory).runStreamed(options.request.input,
      { outputSchema: options.request.outputSchema, ...(options.request.signal ? { signal: options.request.signal } : {}) });
    let answer: string | undefined;
    let completed = false;
    for await (const event of turn.events) {
      if (event.type === "item.completed") {
        if (event.item.type === "agent_message") answer = event.item.text;
        else if (event.item.type !== "reasoning") throw new Error("Review attempted a tool");
      } else if (event.type === "turn.completed") completed = true;
      else if (event.type === "error" || event.type === "turn.failed" || event.type === "local.activity") {
        throw new Error("Review unavailable");
      }
    }
    if (!completed || !answer || answer.length > 4096) throw new Error("Review unavailable");
    return JSON.parse(answer) as unknown;
  } finally {
    try { if (runtime) await runtime.close(); stopped = true; }
    finally {
      // Retain the version pin if teardown is uncertain, matching worker ownership semantics.
      if (stopped) options.lease?.release();
      if (directory && stopped) await rm(directory, { recursive: true, force: true });
    }
  }
}
