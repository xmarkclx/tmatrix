import type { Logger } from "pino";
import { IDENTITY_CONTRACT_HEADERS, parseIdentityJson } from "./identity-transport.js";
import WebSocket from "ws";
import type { WorkerConfig } from "./config.js";
import { errorContext, WorkerError } from "./errors.js";
import type { Metrics } from "./metrics.js";
import {
  cancellationRequestSchema,
  type CancellationRequest
} from "./types.js";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;
const MIN_RECONNECT_DELAY_MS = 500;
const CLOSE_WAIT_MS = 1_000;

/** Minimal socket surface kept injectable so reconnect behavior is deterministic in tests. */
export interface ControlSocket {
  readonly readyState: number;
  on(event: string, listener: (...arguments_: unknown[]) => void): unknown;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type ControlSocketFactory = (
  url: string,
  headers: Record<string, string>
) => ControlSocket;

/**
 * Maintains one outbound authenticated push channel. Durable delivery remains
 * the poll response; this socket only reduces cancellation latency.
 */
export class ControlClient {
  private readonly config: WorkerConfig;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly onCancellation: (request: CancellationRequest) => void | Promise<void>;
  private readonly createSocket: ControlSocketFactory;
  private readonly random: () => number;
  private desiredUrl: string | undefined;
  private endpointPath: string | undefined;
  private socket: ControlSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private generation = 0;
  private reconnectAttempt = 0;
  private awaitingPong = false;
  private stopped = false;

  constructor(options: {
    config: WorkerConfig;
    logger: Logger;
    metrics: Metrics;
    onCancellation: (request: CancellationRequest) => void | Promise<void>;
    createSocket?: ControlSocketFactory;
    random?: () => number;
  }) {
    this.config = options.config;
    this.logger = options.logger.child({ component: "control_client" });
    this.metrics = options.metrics;
    this.onCancellation = options.onCancellation;
    this.createSocket = options.createSocket ?? ((url, headers) =>
      new WebSocket(url, { headers }) as unknown as ControlSocket);
    this.random = options.random ?? Math.random;
  }

  /** Connects to a validated server-advertised URL, without ever logging it. */
  updateUrl(value: string): void {
    if (this.stopped) return;
    let validated: URL;
    try {
      validated = validateControlUrl(value, this.config);
    } catch (cause) {
      this.metrics.increment("control_url_rejected");
      this.logger.error({
        event: "control.url_rejected",
        ...errorContext(cause)
      }, "AI control WebSocket URL was rejected");
      return;
    }

    const nextUrl = validated.toString();
    // The current socket's close handler owns reconnect scheduling. Repeated
    // poll advertisements must not reset its exponential backoff.
    if (nextUrl === this.desiredUrl) return;

    this.generation += 1;
    this.clearTimers();
    this.closeCurrentSocket();
    this.desiredUrl = nextUrl;
    this.endpointPath = validated.pathname;
    this.reconnectAttempt = 0;
    this.connect(this.generation);
  }

  /** Disconnects until a successful poll advertises an authorized URL again. */
  suspend(): void {
    if (this.stopped) return;
    this.generation += 1;
    this.desiredUrl = undefined;
    this.clearTimers();
    this.closeCurrentSocket();
  }

  /** Permanently closes the push channel after the supervisor drains its runs. */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.desiredUrl = undefined;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === SOCKET_CLOSED) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        try {
          socket.terminate();
        } catch {
          // The connection may already have disappeared.
        }
        finish();
      }, CLOSE_WAIT_MS);
      timeout.unref();
      socket.on("close", finish);
      try {
        socket.close(1000, "Worker stopped");
      } catch {
        finish();
      }
    });
  }

  private connect(generation: number): void {
    const url = this.desiredUrl;
    if (this.stopped || generation !== this.generation || !url) return;

    this.metrics.increment("control_connect_attempts");
    this.logger.debug({
      event: "control.connecting",
      endpoint_path: this.endpointPath,
      reconnect_attempt: this.reconnectAttempt
    }, "Connecting AI control WebSocket");

    let socket: ControlSocket;
    try {
      socket = this.createSocket(url, {
        ...IDENTITY_CONTRACT_HEADERS,
        authorization: `Bearer ${this.config.api_key}`,
        "user-agent": "aiworker/0.1.0",
        "x-aiworker-instance": this.config.instance_id,
        ...(this.config.swarm_id
          ? { "x-aiworker-swarm": this.config.swarm_id }
          : {})
      });
    } catch {
      this.metrics.increment("control_connect_failed");
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;

    socket.on("open", () => {
      if (this.stopped || generation !== this.generation || this.socket !== socket) {
        socket.close(1000, "Superseded");
        return;
      }
      this.reconnectAttempt = 0;
      this.awaitingPong = false;
      this.metrics.increment("control_connected");
      this.logger.info({
        event: "control.connected",
        endpoint_path: this.endpointPath
      }, "AI control WebSocket connected");
      this.startPing(socket, generation);
    });

    socket.on("pong", () => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.awaitingPong = false;
    });

    socket.on("message", (value, isBinary) => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.receive(value, isBinary === true);
    });

    socket.on("error", () => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.metrics.increment("control_errors");
      this.logger.warn({
        event: "control.socket_error",
        endpoint_path: this.endpointPath
      }, "AI control WebSocket reported an error");
    });

    socket.on("close", () => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.socket = undefined;
      this.clearPingTimer();
      this.metrics.increment("control_disconnected");
      this.logger.warn({
        event: "control.disconnected",
        endpoint_path: this.endpointPath
      }, "AI control WebSocket disconnected");
      this.scheduleReconnect(generation);
    });
  }

  private receive(value: unknown, isBinary: boolean): void {
    if (isBinary) {
      this.rejectMessage("binary");
      return;
    }
    const text = controlMessageText(value);
    if (text === undefined || Buffer.byteLength(text) > MAX_CONTROL_MESSAGE_BYTES) {
      this.rejectMessage("size_or_encoding");
      return;
    }
    if (text === "pong") return;

    let parsed: unknown;
    try {
      parsed = parseIdentityJson(text);
    } catch {
      this.rejectMessage("json");
      return;
    }
    if (isConnectedControlEnvelope(parsed)) return;
    const envelope = asControlEnvelope(parsed);
    const result = cancellationRequestSchema.safeParse(envelope);
    if (!result.success) {
      this.rejectMessage("schema");
      return;
    }

    this.metrics.increment("control_cancellations_received");
    Promise.resolve(this.onCancellation(result.data)).catch((cause) => {
      this.logger.error({
        event: "control.cancellation_handler_failed",
        event_id: result.data.event_id,
        ticket_id: result.data.ticket_id,
        worker_id: result.data.worker_id,
        ...errorContext(cause)
      }, "AI cancellation handler failed");
    });
  }

  private rejectMessage(reason: string): void {
    this.metrics.increment("control_messages_rejected");
    this.logger.warn({
      event: "control.message_rejected",
      rejection_reason: reason
    }, "AI control WebSocket message was rejected");
  }

  private startPing(socket: ControlSocket, generation: number): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (
        this.stopped ||
        generation !== this.generation ||
        this.socket !== socket ||
        socket.readyState !== SOCKET_OPEN
      ) return;
      try {
        if (this.awaitingPong) {
          socket.terminate();
          return;
        }
        this.awaitingPong = true;
        socket.ping();
      } catch {
        try {
          socket.terminate();
        } catch {
          // The close event, if any, will drive reconnection.
        }
      }
    }, this.config.control_ping_interval_ms);
    this.pingTimer.unref();
  }

  private scheduleReconnect(generation: number): void {
    if (
      this.stopped ||
      generation !== this.generation ||
      !this.desiredUrl ||
      this.reconnectTimer
    ) return;
    this.reconnectAttempt += 1;
    const exponential = Math.min(
      MIN_RECONNECT_DELAY_MS * 2 ** Math.min(this.reconnectAttempt - 1, 10),
      this.config.control_reconnect_max_ms
    );
    const delay = Math.max(1, Math.round(exponential * (0.75 + this.random() * 0.5)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(generation);
    }, delay);
    this.reconnectTimer.unref();
    this.logger.debug({
      event: "control.reconnect_scheduled",
      delay_ms: delay,
      reconnect_attempt: this.reconnectAttempt
    }, "AI control WebSocket reconnect scheduled");
  }

  private closeCurrentSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === SOCKET_CLOSED) return;
    try {
      socket.close(1000, "Control URL changed");
    } catch {
      try {
        socket.terminate();
      } catch {
        // The old connection is already unusable.
      }
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.awaitingPong = false;
  }

  private clearTimers(): void {
    this.clearPingTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}

function validateControlUrl(value: string, config: WorkerConfig): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new WorkerError({
      message: "control_url must be an absolute URL",
      code: "CONTROL_URL_INVALID",
      stage: "control.validate",
      cause
    });
  }
  const poll = new URL(config.poll_origin);
  if (
    url.protocol !== "wss:" ||
    url.host !== poll.host ||
    url.pathname !== "/api/v1/ai/events" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new WorkerError({
      message: "control_url must be credential-free WSS on the poll API origin",
      code: "CONTROL_URL_REJECTED",
      stage: "control.validate",
      details: { protocol: url.protocol, host_matches: url.host === poll.host }
    });
  }

  const keys = [...url.searchParams.keys()];
  const instanceIds = url.searchParams.getAll("instance_id");
  const swarmIds = url.searchParams.getAll("swarm_id");
  const hasOnlyKnownKeys = keys.every((key) =>
    key === "instance_id" || key === "swarm_id"
  );
  const instanceMatches = instanceIds.length === 1 &&
    instanceIds[0] === config.instance_id;
  const swarmMatches = config.swarm_id === undefined
    ? swarmIds.length === 0
    : swarmIds.length === 1 && swarmIds[0] === config.swarm_id;
  if (!hasOnlyKnownKeys || !instanceMatches || !swarmMatches) {
    throw new WorkerError({
      message: "control_url identity query does not match this worker",
      code: "CONTROL_URL_IDENTITY_REJECTED",
      stage: "control.validate",
      details: {
        known_keys_only: hasOnlyKnownKeys,
        instance_matches: instanceMatches,
        swarm_matches: swarmMatches
      }
    });
  }
  return url;
}

function controlMessageText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (Array.isArray(value) && value.every((entry) => Buffer.isBuffer(entry))) {
    return Buffer.concat(value).toString("utf8");
  }
  return undefined;
}

/** Accepts the versioned push envelope and direct items for poll-shape parity. */
function asControlEnvelope(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "cancellation-request" && record.version === 1) {
    return record.request;
  }
  return value;
}

function isConnectedControlEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.version === 1 && record.kind === "connected";
}
