import type { SecurityAlert } from "./security-screening.js";
import { randomUUID } from "node:crypto";
import { IDENTITY_CONTRACT_HEADERS, parseIdentityJson, stringifyIdentityJson } from "./identity-transport.js";
import type { Logger } from "pino";
import type { WorkerConfig } from "./config.js";
import { errorContext, WorkerError } from "./errors.js";
import type { Metrics } from "./metrics.js";
import {
  pollResponseSchema,
  type CancellationRequest,
  type PollRequest,
  type PollResponse,
  type ProgressEvent,
  type Ticket,
  type TicketResult
} from "./types.js";

type Fetch = typeof globalThis.fetch;
type Sleep = (milliseconds: number) => Promise<void>;
type EndpointName =
  | "mark_taken"
  | "progress"
  | "history"
  | "result"
  | "cancellation_ack";
type TicketEndpointName = Exclude<EndpointName, "cancellation_ack">;

interface BoundEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH";
  url: string;
  path: string;
}

interface RequestOptions {
  operation: string;
  method: BoundEndpoint["method"];
  url: string;
  path: string;
  body?: unknown;
  expectJson?: boolean;
  signal?: AbortSignal;
}

export interface TicketApi {
  markTaken(ticket: Ticket, signal?: AbortSignal): Promise<void>;
  getHistory(ticket: Ticket, signal?: AbortSignal): Promise<unknown>;
  reportProgress(ticket: Ticket, event: ProgressEvent, signal?: AbortSignal): Promise<void>;
  reportResult(ticket: Ticket, result: TicketResult, signal?: AbortSignal): Promise<unknown>;
}

export interface CancellationApi {
  acknowledgeCancellation(
    request: CancellationRequest,
    signal?: AbortSignal
  ): Promise<void>;
}

export class ApiClient implements TicketApi {
  private readonly config: WorkerConfig;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly fetch: Fetch;
  private readonly sleep: Sleep;
  private readonly random: () => number;

  constructor(options: {
    config: WorkerConfig;
    logger: Logger;
    metrics: Metrics;
    fetch?: Fetch;
    sleep?: Sleep;
    random?: () => number;
  }) {
    this.config = options.config;
    this.logger = options.logger.child({ component: "api_client" });
    this.metrics = options.metrics;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
  }

  /** Uses the configured trusted API origin; prompt content cannot choose the recipient or endpoint. */
  async alertUserEmergency(alert: SecurityAlert, signal?: AbortSignal): Promise<unknown> {
    const url = new URL("/api/v1/alert-user-emergency", this.config.poll_origin);
    return this.request({ operation: "security_alert", method: "POST", url: url.toString(),
      path: url.pathname, body: alert, expectJson: true, ...(signal ? { signal } : {}) });
  }

  async poll(request: PollRequest, signal?: AbortSignal): Promise<PollResponse> {
    const url = new URL(this.config.poll_url);
    const response = await this.request({
      operation: "poll",
      method: "POST",
      url: url.toString(),
      path: url.pathname,
      body: request,
      expectJson: true,
      ...(signal ? { signal } : {})
    });

    const parsed = pollResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new WorkerError({
        message: "Poll response did not match the worker contract",
        code: "POLL_RESPONSE_INVALID",
        stage: "poll.parse",
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        }
      });
    }
    return parsed.data;
  }

  async markTaken(ticket: Ticket, signal?: AbortSignal): Promise<void> {
    const endpoint = this.endpoint(ticket, "mark_taken");
    await this.request({
      operation: "mark_taken",
      ...endpoint,
      body: this.ticketEnvelope(ticket),
      ...(signal ? { signal } : {})
    });
  }

  async getHistory(ticket: Ticket, signal?: AbortSignal): Promise<unknown> {
    const endpoint = this.endpoint(ticket, "history");
    const url = new URL(endpoint.url);
    for (const [name, value] of Object.entries(this.ticketEnvelope(ticket))) {
      url.searchParams.set(name, String(value));
    }
    return this.request({
      operation: "history",
      ...endpoint,
      url: url.toString(),
      ...(signal ? { signal } : {})
    });
  }

  async reportProgress(ticket: Ticket, event: ProgressEvent, signal?: AbortSignal): Promise<void> {
    const endpoint = this.endpoint(ticket, "progress");
    await this.request({
      operation: "progress",
      ...endpoint,
      body: { ...this.ticketEnvelope(ticket, event.input_revision), event },
      ...(signal ? { signal } : {})
    });
  }

  async reportResult(ticket: Ticket, result: TicketResult, signal?: AbortSignal): Promise<unknown> {
    const endpoint = this.endpoint(ticket, "result");
    return this.request({
      operation: "result",
      ...endpoint,
      body: { ...this.ticketEnvelope(ticket, result.input_revision), ...result },
      ...(signal ? { signal } : {})
    });
  }

  /** Confirms a cancellation only after the owning local process has stopped. */
  async acknowledgeCancellation(
    request: CancellationRequest,
    signal?: AbortSignal
  ): Promise<void> {
    const endpoint = this.boundEndpoint({
      binding: request.acknowledge,
      name: "cancellation_ack",
      ticketId: request.ticket_id,
      requiredMethod: "POST"
    });
    await this.request({
      operation: "cancellation_ack",
      ...endpoint,
      body: {
        event_id: request.event_id,
        ticket_id: request.ticket_id,
        worker_id: request.worker_id,
        instance_id: this.config.instance_id,
        ...(this.config.swarm_id ? { swarm_id: this.config.swarm_id } : {})
      },
      ...(signal ? { signal } : {})
    });
  }

  private ticketEnvelope(
    ticket: Ticket,
    inputRevision = ticket.input_revision ?? 0
  ): Record<string, unknown> {
    return {
      ticket_id: ticket.ticket_id,
      worker_id: ticket.worker_id,
      instance_id: this.config.instance_id,
      ...(this.config.swarm_id ? { swarm_id: this.config.swarm_id } : {}),
      input_revision: inputRevision
    };
  }

  private endpoint(ticket: Ticket, name: TicketEndpointName): BoundEndpoint {
    const binding = ticket.endpoints[name];
    return this.boundEndpoint({
      binding,
      name,
      ticketId: ticket.ticket_id,
      ...(name === "history" ? { requiredMethod: "GET" as const } : {})
    });
  }

  /** Validates an API-provided action binding before attaching the worker key. */
  private boundEndpoint(options: {
    binding: string;
    name: EndpointName;
    ticketId: string;
    requiredMethod?: BoundEndpoint["method"];
  }): BoundEndpoint {
    const { binding, name, ticketId, requiredMethod } = options;
    const match = /^(GET|POST|PUT|PATCH)\s+(.+)$/i.exec(binding.trim());
    if (!match?.[1] || !match[2]) {
      throw new WorkerError({
        message: `Invalid ${name} endpoint binding; expected \"METHOD https://...\"`,
        code: "ENDPOINT_BINDING_INVALID",
        stage: `report.${name}.validate`,
        details: { ticket_id: ticketId, endpoint_name: name }
      });
    }

    const method = match[1].toUpperCase() as BoundEndpoint["method"];
    if (
      (requiredMethod !== undefined && method !== requiredMethod) ||
      (requiredMethod === undefined && name !== "history" && method === "GET")
    ) {
      throw new WorkerError({
        message: `Invalid HTTP method for ${name} endpoint`,
        code: "ENDPOINT_METHOD_REJECTED",
        stage: `report.${name}.validate`,
        details: { ticket_id: ticketId, endpoint_name: name, method }
      });
    }
    let url: URL;
    try {
      url = new URL(match[2]);
    } catch (cause) {
      throw new WorkerError({
        message: `Invalid URL in ${name} endpoint binding`,
        code: "ENDPOINT_URL_INVALID",
        stage: `report.${name}.validate`,
        details: { ticket_id: ticketId, endpoint_name: name },
        cause
      });
    }

    if (url.protocol !== "https:" || url.origin !== this.config.poll_origin || url.username || url.password) {
      throw new WorkerError({
        message: `${name} endpoint must be credential-free HTTPS on the poll API origin`,
        code: "ENDPOINT_ORIGIN_REJECTED",
        stage: `report.${name}.validate`,
        details: {
          ticket_id: ticketId,
          endpoint_name: name,
          endpoint_origin: url.origin,
          expected_origin: this.config.poll_origin
        }
      });
    }

    return { method, url: url.toString(), path: url.pathname };
  }

  private async request(options: RequestOptions): Promise<unknown> {
    const operationId = randomUUID();
    const startedAt = Date.now();
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.max_request_attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Request timed out")), this.config.request_timeout_ms);
      const abortFromCaller = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) abortFromCaller();
      else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
      const attemptStartedAt = Date.now();

      try {
        this.logger.debug({
          event: "http.request_started",
          operation: options.operation,
          operation_id: operationId,
          method: options.method,
          endpoint_path: options.path,
          attempt
        }, "Outbound API request started");

        const response = await this.fetch(options.url, {
          method: options.method,
          headers: {
            ...IDENTITY_CONTRACT_HEADERS,
            authorization: `Bearer ${this.config.api_key}`,
            accept: "application/json",
            "content-type": "application/json",
            "user-agent": "aiworker/0.1.0",
            "x-aiworker-instance": this.config.instance_id,
            "x-request-id": operationId
          },
          ...(options.body !== undefined && options.method !== "GET" ? { body: stringifyIdentityJson(options.body) } : {}),
          signal: controller.signal
        });

        const responseText = await response.text();
        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          throw new WorkerError({
            message: `API returned HTTP ${response.status} for ${options.operation}`,
            code: "HTTP_STATUS_ERROR",
            stage: `http.${options.operation}`,
            retryable,
            details: {
              operation: options.operation,
              operation_id: operationId,
              status: response.status,
              response_bytes: Buffer.byteLength(responseText),
              retry_after: response.headers.get("retry-after") ?? undefined
            }
          });
        }

        let value: unknown;
        if (responseText === "") {
          value = undefined;
        } else if (options.expectJson || response.headers.get("content-type")?.includes("application/json")) {
          try {
            value = parseIdentityJson(responseText);
          } catch (cause) {
            throw new WorkerError({
              message: `API returned invalid JSON for ${options.operation}`,
              code: "HTTP_RESPONSE_JSON_INVALID",
              stage: `http.${options.operation}.parse`,
              details: {
                operation: options.operation,
                operation_id: operationId,
                response_bytes: Buffer.byteLength(responseText)
              },
              cause
            });
          }
        } else {
          value = responseText;
        }

        const durationMs = Date.now() - attemptStartedAt;
        this.metrics.observeDuration(`http.${options.operation}`, durationMs);
        this.logger.debug({
          event: "http.request_succeeded",
          operation: options.operation,
          operation_id: operationId,
          method: options.method,
          endpoint_path: options.path,
          status: response.status,
          attempt,
          duration_ms: durationMs
        }, "Outbound API request succeeded");
        return value;
      } catch (cause) {
        lastError = this.normalizeRequestError(cause, options, operationId);
        const retryable = lastError instanceof WorkerError && lastError.retryable;
        const willRetry = retryable && attempt < this.config.max_request_attempts && !options.signal?.aborted;
        this.logger[willRetry ? "warn" : "error"]({
          event: willRetry ? "http.request_retrying" : "http.request_failed",
          operation: options.operation,
          operation_id: operationId,
          method: options.method,
          endpoint_path: options.path,
          attempt,
          duration_ms: Date.now() - attemptStartedAt,
          will_retry: willRetry,
          ...errorContext(lastError)
        }, willRetry ? "Outbound API request failed; retrying" : "Outbound API request failed");

        if (!willRetry) break;
        this.metrics.increment("http_retries");
        await this.sleep(this.retryDelay(attempt, lastError));
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromCaller);
      }
    }

    this.metrics.observeDuration(`http.${options.operation}.failed`, Date.now() - startedAt);
    throw lastError;
  }

  private normalizeRequestError(
    cause: unknown,
    options: RequestOptions,
    operationId: string
  ): WorkerError {
    if (cause instanceof WorkerError) return cause;
    if (options.signal?.aborted) {
      return new WorkerError({
        message: `API request aborted for ${options.operation}`,
        code: "HTTP_REQUEST_ABORTED",
        stage: `http.${options.operation}`,
        details: { operation: options.operation, operation_id: operationId },
        cause
      });
    }
    return new WorkerError({
      message: `Network request failed for ${options.operation}`,
      code: "HTTP_NETWORK_ERROR",
      stage: `http.${options.operation}`,
      retryable: true,
      details: { operation: options.operation, operation_id: operationId },
      cause
    });
  }

  private retryDelay(attempt: number, error: unknown): number {
    const retryAfter = error instanceof WorkerError ? error.details.retry_after : undefined;
    if (typeof retryAfter === "string") {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
    }

    const exponential = Math.min(250 * 2 ** (attempt - 1), 10_000);
    return Math.round(exponential * (0.75 + this.random() * 0.5));
  }
}
