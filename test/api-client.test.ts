import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api-client.js";
import { Metrics } from "../src/metrics.js";
import { nullLogger } from "../src/logger.js";
import { makeCancellation, makeConfig, makeTicket } from "./helpers.js";

describe("ApiClient", () => {
  it.each([undefined, "01a102a4-c231-7dd2-b520-f3526b5bcecc"])("propagates the selected workspace through poll, taken, history, progress, result and cancellation: %s", async (teamId) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    const client = new ApiClient({ config: makeConfig({ team_id: teamId }), logger: nullLogger(), metrics: new Metrics(), fetch });
    const ticket=makeTicket();
    await client.poll({ poll_id: "poll-scope", instance_id: "test-instance", available_slots: 1 });
    await client.markTaken(ticket);
    await client.getHistory(ticket);
    await client.reportProgress(ticket, { kind: "worker-started", input_revision: 1, sequence: 1, occurred_at: "2026-10-09T00:00:00.000Z", summary: {} });
    await client.reportResult(ticket, { status: "completed", input_revision: 1, outcome: "AI_DONE", context_summary: "context", user_message: "Ready", started_at: "2026-09-29T10:00:00.000Z", completed_at: "2026-09-29T10:01:00.000Z", duration_ms: 60_000 });
    await client.acknowledgeCancellation(makeCancellation());
    expect(fetch).toHaveBeenCalledTimes(6);
    for (const [,options] of fetch.mock.calls) expect(new Headers(options?.headers).get("x-tzudo-workspace")).toBe(teamId ? `team:${teamId}` : null);
  });

  it("sends only the bound warning payload to the configured origin with host authentication", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"status":"sent"}'));
    const client = new ApiClient({ config: makeConfig(), logger: nullLogger(), metrics: new Metrics(), fetch });
    expect(await client.alertUserEmergency({ ticket_id: "ticket", worker_id: "worker", input_digest: "a".repeat(64), category: "security_bypass" })).toEqual({ status: "sent" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://tasks.example.test/api/v1/alert-user-emergency");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-secret-key");
    expect(JSON.parse(String(init?.body))).toEqual({ ticket_id: "ticket", worker_id: "worker", input_digest: "a".repeat(64), category: "security_bypass" });
  });
  it("returns accepted handoff comment identities for conversation continuity", async () => {
    const receipt = { success: true, comment_id: "9223372036854775807", result_comment_id: "9223372036854775807", context_comment_id: "9223372036854775807" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(receipt), { headers: { "content-type": "application/json" } }));
    const client = new ApiClient({ config: makeConfig(), logger: nullLogger(), metrics: new Metrics(), fetch });
    expect(await client.reportResult(makeTicket(), {
      status: "completed", input_revision: 1, outcome: "AI_DONE", context_summary: "context", user_message: "Ready",
      started_at: "2026-09-29T10:00:00.000Z", completed_at: "2026-09-29T10:01:00.000Z", duration_ms: 60_000
    })).toEqual(receipt);
  });

  it.each(["01994edd-45af-7baa-a478-628490a83d1a", 1500000000, 2000000000, "9007199254740993", "9223372036854775807"])(
    "preserves legacy and decimal identity %s through HTTP history and progress", async (id) => {
      const history = { task: { id }, comments: [{ id, taskId: id }] };
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(
        JSON.stringify(history), { headers: { "content-type": "application/json" } }
      ));
      const client = new ApiClient({ config: makeConfig(), logger: nullLogger(), metrics: new Metrics(), fetch });
      const restored = await client.getHistory(makeTicket());
      expect(restored).toEqual(history);
      await client.reportProgress(makeTicket(), {
        sequence: 1, occurred_at: new Date().toISOString(), kind: "checkpoint",
        input_revision: 1, summary: { history: restored }
      });
      expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).event.summary.history).toEqual(history);
    }
  );

  it("rejects an unsafe numeric ID in untyped HTTP history", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      '{"task":{"id":9007199254740993}}', { headers: { "content-type": "application/json" } }
    ));
    const client = new ApiClient({ config: makeConfig(), logger: nullLogger(), metrics: new Metrics(), fetch });
    await expect(client.getHistory(makeTicket())).rejects.toMatchObject({ code: "HTTP_RESPONSE_JSON_INVALID" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("polls with the instance identity and parses tickets", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      new_tickets: [makeTicket({
        task_id: 42,
        input_revision: 3,
        project_path: "/workspace/project",
        trigger_comment_id: null
      })],
      owned_in_progress: [{ ticket_id: "T-old", worker_id: "w-old" }],
      steering_events: [{
        worker_id: "w-old",
        input_revision: 4,
        content: "Use the edited requirements.",
        trigger_comment_id: null
      }],
      cancellation_requests: [makeCancellation()],
      control_url:
        "wss://tasks.example.test/api/v1/ai/events?instance_id=test-instance&swarm_id=test-swarm"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new ApiClient({
      config: makeConfig(),
      logger: nullLogger(),
      metrics: new Metrics(),
      fetch
    });

    const response = await client.poll({
      poll_id: "57a2a78b-74cc-4b87-b9f5-012b3e1ac620",
      instance_id: "test-instance",
      swarm_id: "test-swarm",
      available_slots: 2
    });

    expect(response.new_tickets).toHaveLength(1);
    expect(response.new_tickets[0]?.trigger_comment_id).toBeNull();
    expect(response.owned_in_progress).toHaveLength(1);
    expect(response.steering_events).toMatchObject([{
      worker_id: "w-old",
      input_revision: 4
    }]);
    expect(response.cancellation_requests).toEqual([makeCancellation()]);
    expect(response.control_url).toBe(
      "wss://tasks.example.test/api/v1/ai/events?instance_id=test-instance&swarm_id=test-swarm"
    );
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://tasks.example.test/api/poll");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-secret-key");
    expect((init?.headers as Record<string, string>)["x-tzudo-identity-version"]).toBe("3");
    expect(JSON.parse(String(init?.body))).toEqual({
      poll_id: "57a2a78b-74cc-4b87-b9f5-012b3e1ac620",
      instance_id: "test-instance",
      swarm_id: "test-swarm",
      available_slots: 2
    });
  });

  it("retries retryable statuses and records the retry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ new_tickets: [], owned_in_progress: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    const sleep = vi.fn(async () => undefined);
    const metrics = new Metrics();
    const client = new ApiClient({
      config: makeConfig(),
      logger: nullLogger(),
      metrics,
      fetch,
      sleep,
      random: () => 0
    });

    await client.poll({
      poll_id: "04228dc4-7ec5-46b2-af75-504f9ad326bd",
      instance_id: "test-instance",
      available_slots: 1
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.map((call) => call[1]?.body)).toEqual([
      fetch.mock.calls[0]![1]?.body,
      fetch.mock.calls[0]![1]?.body
    ]);
    expect((metrics.snapshot().counters as Record<string, number>).http_retries).toBe(1);
  });

  it("sends the revision envelope in action bodies and history query parameters", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(
      JSON.stringify({ comments: [] }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const client = new ApiClient({
      config: makeConfig(),
      logger: nullLogger(),
      metrics: new Metrics(),
      fetch
    });
    const ticket = makeTicket({ input_revision: 7 });

    await client.markTaken(ticket);
    await client.getHistory(ticket);
    await client.reportProgress(ticket, {
      sequence: 1,
      occurred_at: new Date().toISOString(),
      kind: "turn.completed",
      input_revision: 8,
      summary: {}
    });
    await client.reportResult(ticket, {
      status: "completed",
      input_revision: 9,
      outcome: "AI_DONE",
      context_summary: "Completed the task.",
      user_message: "Ready for review.",
      final_response: "Ready for review.",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 1
    });

    const takenBody = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(takenBody).toMatchObject({
      ticket_id: ticket.ticket_id,
      worker_id: ticket.worker_id,
      instance_id: "test-instance",
      swarm_id: "test-swarm",
      input_revision: 7
    });

    const historyUrl = new URL(String(fetch.mock.calls[1]![0]));
    expect(fetch.mock.calls[1]![1]?.method).toBe("GET");
    expect(Object.fromEntries(historyUrl.searchParams)).toEqual({
      ticket_id: ticket.ticket_id,
      worker_id: ticket.worker_id,
      instance_id: "test-instance",
      swarm_id: "test-swarm",
      input_revision: "7"
    });

    const progressBody = JSON.parse(String(fetch.mock.calls[2]![1]?.body));
    expect(progressBody.input_revision).toBe(8);
    expect(progressBody.event.input_revision).toBe(8);

    const resultBody = JSON.parse(String(fetch.mock.calls[3]![1]?.body));
    expect(resultBody).toMatchObject({
      input_revision: 9,
      outcome: "AI_DONE",
      context_summary: "Completed the task.",
      user_message: "Ready for review."
    });
  });

  it("rejects action endpoints outside the authenticated poll origin", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new ApiClient({
      config: makeConfig(),
      logger: nullLogger(),
      metrics: new Metrics(),
      fetch
    });
    const ticket = makeTicket({
      endpoints: {
        ...makeTicket().endpoints,
        result: "POST https://attacker.example/result"
      }
    });

    await expect(client.reportResult(ticket, {
      status: "completed",
      input_revision: 0,
      outcome: "AI_DONE",
      context_summary: "Completed the task.",
      user_message: "Ready for review.",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 1
    })).rejects.toMatchObject({ code: "ENDPOINT_ORIGIN_REJECTED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("acknowledges cancellation with the exact bound identity after validation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, { status: 204 })
    );
    const client = new ApiClient({
      config: makeConfig(),
      logger: nullLogger(),
      metrics: new Metrics(),
      fetch
    });

    await client.acknowledgeCancellation(makeCancellation());

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://tasks.example.test/api/v1/ai/tickets/T-1001/cancellation-ack"
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      event_id: "cancel-1001",
      ticket_id: "T-1001",
      worker_id: "w-1001",
      instance_id: "test-instance",
      swarm_id: "test-swarm"
    });
  });

  it("rejects cancellation acknowledgement bindings that could leak credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new ApiClient({
      config: makeConfig(),
      logger: nullLogger(),
      metrics: new Metrics(),
      fetch
    });

    await expect(client.acknowledgeCancellation(makeCancellation({
      acknowledge: "POST https://attacker.example/cancellation-ack"
    }))).rejects.toMatchObject({ code: "ENDPOINT_ORIGIN_REJECTED" });
    await expect(client.acknowledgeCancellation(makeCancellation({
      acknowledge:
        "GET https://tasks.example.test/api/v1/ai/tickets/T-1001/cancellation-ack"
    }))).rejects.toMatchObject({ code: "ENDPOINT_METHOD_REJECTED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight cancellation acknowledgement when authorization is revoked", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async (_input, init) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          }, { once: true });
        });
        return new Response(null, { status: 204 });
      }
    );
    const client = new ApiClient({
      config: makeConfig(),
      logger: nullLogger(),
      metrics: new Metrics(),
      fetch
    });
    const controller = new AbortController();
    const acknowledgement = client.acknowledgeCancellation(
      makeCancellation(),
      controller.signal
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    controller.abort(new Error("Poll authorization was revoked"));

    await expect(acknowledgement).rejects.toMatchObject({
      code: "HTTP_REQUEST_ABORTED",
      stage: "http.cancellation_ack"
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
