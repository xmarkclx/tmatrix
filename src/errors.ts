export type ErrorDetails = Record<string, unknown>;

export class WorkerError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly retryable: boolean;
  readonly details: ErrorDetails;

  constructor(options: {
    message: string;
    code: string;
    stage: string;
    retryable?: boolean;
    details?: ErrorDetails;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "WorkerError";
    this.code = options.code;
    this.stage = options.stage;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export type RunCancellationKind = "user" | "ownership_revoked";

/**
 * Internal control-flow reason for a run that must stop without reporting a
 * retryable worker failure. It deliberately carries identifiers, not user text.
 */
export class RunCancellationError extends Error {
  readonly kind: RunCancellationKind;
  readonly eventId?: string;
  readonly ticketId: string;
  readonly workerId: string;

  constructor(options: {
    kind: RunCancellationKind;
    ticketId: string;
    workerId: string;
    eventId?: string;
  }) {
    super(options.kind === "user"
      ? "AI work was cancelled by the user"
      : "AI work ownership was revoked");
    this.name = "RunCancellationError";
    this.kind = options.kind;
    this.ticketId = options.ticketId;
    this.workerId = options.workerId;
    if (options.eventId !== undefined) this.eventId = options.eventId;
  }
}

/** Reads the typed cancellation reason carried by a run's AbortSignal. */
export function cancellationReason(
  signal?: AbortSignal
): RunCancellationError | undefined {
  return signal?.reason instanceof RunCancellationError
    ? signal.reason
    : undefined;
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : "Unknown non-Error failure");
}

export function errorContext(value: unknown): Record<string, unknown> {
  const error = toError(value);

  if (error instanceof WorkerError) {
    return {
      error_name: error.name,
      error_message: error.message,
      error_code: error.code,
      error_stage: error.stage,
      retryable: error.retryable,
      ...error.details,
      stack: error.stack
    };
  }

  return {
    error_name: error.name,
    error_message: error.message,
    stack: error.stack
  };
}
