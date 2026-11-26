import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const COMMAND_TIMEOUT_MS = 5_000;
/** The window starts at this size; the console resizes it to fit its panel. */
const COLUMNS = 160;
const ROWS = 48;
export const TMUX_SESSION = "claude";

export interface TerminalReference {
  /** tmux socket name for `tmux -L`; short because Unix socket paths are limited to ~108 bytes. */
  socket: string;
  session: string;
}

export function tmuxAvailable(environment: Record<string, string>): Promise<boolean> {
  if (process.platform === "win32") return Promise.resolve(false);
  return new Promise(resolve => {
    execFile("tmux", ["-V"], { env: environment, timeout: COMMAND_TIMEOUT_MS }, error => resolve(error === null));
  });
}

/** One private tmux server per Claude runtime, so teardown never touches the user's own sessions. */
export class TmuxSession {
  readonly reference: TerminalReference = { socket: `tmx-${randomBytes(6).toString("hex")}`, session: TMUX_SESSION };
  private readonly environment: Record<string, string>;
  private socketPath: string | undefined;

  constructor(environment: Record<string, string>, private readonly stateDirectory: string) {
    this.environment = { ...environment };
    // A server started from inside another tmux would otherwise attach to that one.
    delete this.environment.TMUX;
    delete this.environment.TMUX_PANE;
  }

  async start(command: string[], cwd: string): Promise<void> {
    const config = join(this.stateDirectory, "tmux.conf");
    await writeFile(config, [
      // Keep a crashed Claude on screen so its exit reason can be read.
      "set -g remain-on-exit on",
      "set -g status off",
      "set -g history-limit 20000",
      "set -g mouse off",
      "set -g default-terminal screen-256color",
      ""
    ].join("\n"), { mode: 0o600 });
    await this.run(["-f", config, "new-session", "-d", "-s", TMUX_SESSION,
      "-x", String(COLUMNS), "-y", String(ROWS), "-c", cwd, "--", ...command]);
    const path = (await this.run(["display-message", "-p", "#{socket_path}"]).catch(() => "")).trim();
    if (path.endsWith(`/${this.reference.socket}`)) this.socketPath = path;
  }

  /** Types text literally; newlines are flattened because Enter would submit early. */
  async type(text: string): Promise<void> {
    await this.run(["send-keys", "-t", TMUX_SESSION, "-l", "--", text.replace(/\s*\n\s*/g, " ")]);
  }

  async keys(...keys: string[]): Promise<void> {
    await this.run(["send-keys", "-t", TMUX_SESSION, ...keys]);
  }

  /** Visible screen, or the whole scrollback when `history` is set. */
  async capture(history = false): Promise<string> {
    return this.run(["capture-pane", "-p", "-t", TMUX_SESSION, ...(history ? ["-S", "-"] : [])]);
  }

  async pane(): Promise<{ pid: number; dead: boolean; status: number | undefined } | undefined> {
    const output = await this.run(["display-message", "-p", "-t", TMUX_SESSION, "#{pane_pid} #{pane_dead} #{pane_dead_status}"])
      .catch(() => undefined);
    const [pid, dead, status] = output?.trim().split(" ") ?? [];
    if (!pid || !/^\d+$/.test(pid)) return undefined;
    return { pid: Number(pid), dead: dead === "1", status: status && /^\d+$/.test(status) ? Number(status) : undefined };
  }

  async kill(): Promise<void> {
    await this.run(["kill-server"]).catch(() => undefined);
    // tmux can leave its socket file behind; it is ours alone.
    if (this.socketPath) await rm(this.socketPath, { force: true }).catch(() => undefined);
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("tmux", ["-L", this.reference.socket, ...args], {
        env: this.environment, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024
      }, (error, stdout) => error ? reject(new Error("tmux command failed")) : resolve(stdout));
    });
  }
}
