import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { TicketApi } from "./api-client.js";
import { errorContext, WorkerError } from "./errors.js";
import type { Ticket, TicketResult } from "./types.js";

/** Keeps finished work in its slot during an outage instead of starting the AI again. */
export async function deliverResult(options: {
  api: TicketApi;
  ticket: Ticket;
  result: TicketResult;
  signal: AbortSignal;
  logger: Logger;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<unknown> {
  const wait = options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  for (let attempt = 1; ; attempt += 1) {
    options.signal.throwIfAborted();
    try {
      return await options.api.reportResult(options.ticket, options.result, options.signal);
    } catch (cause) {
      // Invalid credentials, stale revisions and other permanent rejections must
      // reach the runner's existing ownership/failure handling, not retry forever.
      if (!(cause instanceof WorkerError) || !cause.retryable || options.signal.aborted) throw cause;
      options.logger.warn({
        event: "result.delivery_retrying",
        delivery_attempt: attempt,
        ...errorContext(cause)
      }, "Retaining the finished result while waiting for the task API to recover");
      await wait(5_000, options.signal);
    }
  }
}
