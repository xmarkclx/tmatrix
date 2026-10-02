import {
  AppServerCodex,
  type AppServerCodexOptions
} from "./app-server.js";
import type { Logger } from "pino";
import type { CodexFactory, CodexLike } from "../../runner.js";

type CodexCreator = (options: AppServerCodexOptions) => CodexLike;
type ProtocolLogger = Pick<Logger, "error" | "warn">;

/**
 * Creates one isolated App Server process per ticket. Execution settings are
 * passed explicitly when its thread/turn starts, not inherited from the host.
 */
export function createCodexFactory(
  environment: Record<string, string>,
  createCodex: CodexCreator = (options) => new AppServerCodex(options),
  logger?: ProtocolLogger
): CodexFactory {
  return (_profile, leaseEnvironment) => createCodex({
    environment: { ...environment, ...leaseEnvironment },
    ...(logger ? { logger } : {})
  });
}
