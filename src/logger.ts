import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pino, { type Logger, type StreamEntry } from "pino";
import pretty from "pino-pretty";
import { createStream, type FileSize, type Interval } from "rotating-file-stream";
import type { WorkerConfig } from "./config.js";

const REDACT_PATHS = [
  "api_key",
  "*.api_key",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "password",
  "*.password",
  "token",
  "*.token",
  "credentials",
  "*.credentials"
];

export interface LoggerBundle {
  logger: Logger;
  close: () => Promise<void>;
}

export function createLogger(config: WorkerConfig): LoggerBundle {
  let closing = false;
  const streamLevel = config.log_level === "silent" ? "fatal" : config.log_level;
  const streams: StreamEntry[] = [{
    level: streamLevel,
    stream: config.pretty_logs
      ? pretty({ colorize: process.stdout.isTTY, singleLine: true, translateTime: "SYS:standard" })
      : process.stdout
  }];

  const logDir = resolve(config.log_dir);
  mkdirSync(logDir, { recursive: true, mode: 0o750 });
  const rotatingStream = createStream("aiworker.log", {
    path: logDir,
    size: config.log_rotate_size as FileSize,
    interval: config.log_rotate_interval as Interval,
    maxFiles: config.log_max_files,
    compress: "gzip"
  });
  streams.push({ level: streamLevel, stream: rotatingStream });

  const logger = pino({
    level: config.log_level,
    base: {
      service: "aiworker",
      version: "0.1.0",
      instance_id: config.instance_id,
      swarm_id: config.swarm_id
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    formatters: {
      level(label) {
        return { level: label };
      }
    }
  }, pino.multistream(streams));
  const rotationFallbackLogger = pino({
    level: config.log_level,
    base: {
      service: "aiworker",
      version: "0.1.0",
      instance_id: config.instance_id,
      component: "log_rotation"
    },
    timestamp: pino.stdTimeFunctions.isoTime
  }, process.stderr);

  rotatingStream.on("rotated", (filename) => {
    if (closing) return;
    logger.info({ event: "log.rotated", filename }, "Log file rotated");
  });
  rotatingStream.on("removed", (filename) => {
    if (closing) return;
    logger.info({ event: "log.removed", filename }, "Expired log file removed");
  });
  rotatingStream.on("warning", (error) => {
    if (closing) return;
    rotationFallbackLogger.warn(
      { event: "log.rotation_warning", error_message: error.message },
      "Log rotation warning"
    );
  });
  rotatingStream.on("error", (error) => {
    if (closing) return;
    rotationFallbackLogger.error(
      { event: "log.rotation_failed", error_message: error.message },
      "Rotating log stream failed"
    );
  });

  return {
    logger,
    close: async () => {
      if (rotatingStream.destroyed) return;
      closing = true;
      await new Promise<void>((resolveClose, reject) => {
        rotatingStream?.once("error", reject);
        rotatingStream?.end(resolveClose);
      });
    }
  };
}

export function nullLogger(): Logger {
  return pino({ level: "silent" });
}
