import { describe, expect, it } from "vitest";
import { localPromptPreview } from "../src/helpers/local-prompt-preview.js";
import { LocalWorkerState } from "../src/local-worker-state.js";
import { makeTicket } from "./helpers.js";

describe("local run identity", () => {
  it.each(["initial", "resumed"] as const)("retains %s metadata through steering and activity eviction", (run_kind) => {
    const state = new LocalWorkerState();
    const ticket = makeTicket({ input_revision: 7 });
    state.start(ticket);
    expect(state.snapshot()[0]?.run_kind).toBeUndefined();
    state.record(ticket.worker_id, { kind: "thread.started", text: "Conversation connected", thread_id: "fictional-thread", run_kind });
    state.record(ticket.worker_id, { kind: "revision.delivering", text: "Updated input", input_revision: 8 });
    state.record(ticket.worker_id, { kind: "output", text: "x".repeat(150000) });
    expect(state.snapshot()[0]).toMatchObject({ thread_id: "fictional-thread", run_kind, input_revision: 8, activity: [] });
  });
});

describe("local initial prompt", () => {
  it("stays separate from activity and retains its original version through steering and eviction", () => {
    const state = new LocalWorkerState();
    const ticket = makeTicket({ input_revision: 2 });
    state.start(ticket);
    expect(state.snapshot()[0]?.initial_prompt).toBeUndefined();
    state.record(ticket.worker_id, { kind: "prompt.prepared", text: "Original input 👩🏽‍💻", input_revision: 2 });
    for (let i = 0; i < 250; i++) state.record(ticket.worker_id, { kind: "output", text: "Later activity" });
    state.record(ticket.worker_id, { kind: "revision.delivering", text: "Revision changed", input_revision: 3 });
    state.record(ticket.worker_id, { kind: "prompt.prepared", text: "Replacement must not overwrite", input_revision: 3 });
    const worker = state.snapshot()[0]!;
    expect(worker.initial_prompt).toMatchObject({ text: "Original input 👩🏽‍💻", input_revision: 2, truncated: false, redacted: false });
    expect(worker.input_revision).toBe(3);
    expect(worker.activity.some((entry) => entry.kind === "prompt.prepared")).toBe(false);
    worker.initial_prompt!.text = "mutated";
    expect(state.snapshot()[0]?.initial_prompt?.text).toBe("Original input 👩🏽‍💻");
  });

  it("removes terminal controls and redacts common credential forms before truncation", () => {
    const preview = localPromptPreview([
      "\x1b[2JKeep this instruction 👩🏽‍💻\x1b]52;c;clipboard\x07",
      'API_KEY="fictional-key"',
      '{"authorization":"Bearer fictional-bearer"}',
      "password='fictional-password'",
      "https://fictional-user:fictional-password@example.test",
      "https://example.test?token=fictional-query&task=12",
      "sk-proj-fictional00000000000000000",
      "-----BEGIN PRIVATE KEY-----\nfictional-private-key\n-----END PRIVATE KEY-----"
    ].join("\n"));
    expect(preview.text).toContain("Keep this instruction 👩🏽‍💻");
    expect(preview.text).not.toMatch(/fictional|\x1b|clipboard/);
    expect(preview).toMatchObject({ redacted: true, truncated: false });
  });

  it.each(["\\", "👩🏽‍💻", '"', "a"])("bounds serialized preview bytes for %s without broken surrogates", (character) => {
    const preview = localPromptPreview(character.repeat(20000));
    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(preview.text))).toBeLessThanOrEqual(16 * 1024);
    expect(preview.text).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("handles long bare identifiers without blocking the worker event loop", () => {
    // These inputs contain no assignments. Without a left identifier boundary,
    // the optional credential-name prefix scans every suffix of the bare word.
    const started = performance.now();
    for (const input of ["a".repeat(120000), "word_".repeat(24000)]) {
      const preview = localPromptPreview(input);
      expect(preview).toMatchObject({ truncated: true, redacted: false });
      expect(Buffer.byteLength(JSON.stringify(preview.text))).toBeLessThanOrEqual(16 * 1024);
    }
    // Deliberately generous for loaded CI; the bounded implementation takes
    // milliseconds, while the former regex takes several seconds on one input.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("redacts prefixed identifiers while preserving longer noncredential names", () => {
    const preview = localPromptPreview([
      "TZUDO_API_KEY=fictional-key",
      '"x-access-token":"fictional-token"',
      "app_refresh_token='fictional-refresh'",
      "mytoken=ordinary-identifier-value"
    ].join("\n"));
    expect(preview.text).not.toContain("fictional");
    expect(preview.text).toContain("mytoken=ordinary-identifier-value");
    expect(preview.redacted).toBe(true);
  });
});


describe("active worker retention", () => {
  it.each(["completed", "stopped", "failed"] as const)("releases %s workers and ignores late events", (status) => {
    const state = new LocalWorkerState();
    const ticket = makeTicket();
    state.start(ticket);
    state.record(ticket.worker_id, { kind: "prompt.prepared", text: "Initial input" });
    state.queue(ticket.worker_id, "receipt");
    state.status(ticket.worker_id, status);
    state.record(ticket.worker_id, { kind: "output", text: "late" });
    expect(state.snapshot()).toEqual([]);
  });

  it.each(["stopping", "stop_unverified"] as const)("keeps %s visible until teardown is confirmed", (status) => {
    const state = new LocalWorkerState();
    const ticket = makeTicket();
    state.start(ticket);
    state.status(ticket.worker_id, status);
    expect(state.snapshot()[0]?.status).toBe(status);
    state.status(ticket.worker_id, "stopped");
    expect(state.snapshot()).toEqual([]);
  });

  it("retains more than 1000 lines and 200 events when they fit", () => {
    const state = new LocalWorkerState();
    const ticket = makeTicket();
    state.start(ticket);
    for (let i = 0; i < 300; i++) state.record(ticket.worker_id, { kind: "output", text: "a\nb\nc\nd" });
    const activity = state.snapshot()[0]!.activity;
    expect(activity).toHaveLength(301);
    expect(activity.reduce((n, e) => n + e.text.split("\n").length, 0)).toBe(1201);
  });

  it.each(["x", "👩🏽‍💻", "\\", "\n"])("drops oversized %s entries whole and accepts subsequent activity", (text) => {
    const state = new LocalWorkerState();
    const ticket = makeTicket();
    state.start(ticket);
    state.record(ticket.worker_id, { kind: "output", text: text.repeat(150000) + "newest" });
    const activity = state.snapshot()[0]!.activity;
    expect(activity).toEqual([]);
    state.record(ticket.worker_id, { kind: "output", text: "Next complete entry" });
    expect(state.snapshot()[0]!.activity.map(entry => entry.text)).toEqual(["Next complete entry"]);
  });

  it("evicts oldest events while keeping recent events in order", () => {
    const state = new LocalWorkerState();
    const ticket = makeTicket();
    state.start(ticket);
    for (let i = 0; i < 100; i++) state.record(ticket.worker_id, { kind: "output", text: "x".repeat(4096) + i });
    const activity = state.snapshot()[0]!.activity;
    expect(Buffer.byteLength(JSON.stringify(activity))).toBeLessThanOrEqual(128 * 1024);
    expect(activity[0]!.sequence).toBeGreaterThan(1);
    expect(activity.at(-1)!.text.endsWith("99")).toBe(true);
    for (const entry of activity) {
      expect(entry.text).toBe("x".repeat(4096) + (entry.sequence - 2));
    }
    expect(activity.map(e => e.sequence)).toEqual([...activity.map(e => e.sequence)].sort((a, b) => a - b));
  });

  it("caps the separately retained initial prompt by lines", () => {
    const preview = localPromptPreview(Array(500).fill("line").join("\n"));
    expect(preview.text.split("\n")).toHaveLength(200);
    expect(preview.truncated).toBe(true);
  });
});


describe("worker pins", () => {
  it("retains a sanitized steering message and updates its card without duplicates", () => {
    const state = new LocalWorkerState();
    const ticket = makeTicket();
    state.start(ticket);
    state.queue(ticket.worker_id, "message-1", "Check focus\nThen check wrapping\x1b[31m\napi_key=fixture-secret");
    const queued = state.snapshot()[0]!.activity.at(-1)!;
    expect(queued).toMatchObject({ steering_id: "message-1", kind: "steering.queued" });
    expect(queued.text).toContain("Check focus\nThen check wrapping");
    expect(queued.text).toContain("api_key=[REDACTED]");
    expect(JSON.stringify(state.snapshot())).not.toContain("fixture-secret");
    state.record(ticket.worker_id, { kind: "steering.runtime_received", text: "Received by runtime", steering_id: "message-1" });
    state.record(ticket.worker_id, { kind: "steering.response_observed", text: "Visible response observed", steering_id: "message-1" });
    const worker = state.snapshot()[0]!;
    expect(worker.steering[0]).toMatchObject({ status: "response_observed", message: expect.stringContaining("Check focus") });
    expect(worker.activity.filter(event => event.steering_id === "message-1")).toEqual([
      { ...queued, kind: "steering.response_observed", text: expect.stringContaining("Visible response observed") }
    ]);
    expect(worker.activity.at(-1)?.text).toContain("Then check wrapping");
  });

  it("keeps a confirmed receipt distinct from a missing response on worker exit", () => {
    const state = new LocalWorkerState();
    const ticket = makeTicket();
    state.start(ticket);
    state.setPinned(ticket.worker_id, { pinned: true });
    state.queue(ticket.worker_id, "received", "Check focus");
    state.record(ticket.worker_id, { kind: "steering.runtime_received", text: "Received", steering_id: "received" });
    state.status(ticket.worker_id, "completed");
    expect(state.snapshot()[0]!.activity.find(event => event.steering_id === "received")?.text).toContain("Runtime received the message");
  });
  it.each(["completed", "failed", "stopped"] as const)("keeps %s and its history until unpinned", (status) => {
    const state = new LocalWorkerState();
    const ticket = makeTicket();
    state.start(ticket);
    state.record(ticket.worker_id, { kind: "prompt.prepared", text: "Original input" });
    state.queue(ticket.worker_id, "pending");
    expect(state.setPinned(ticket.worker_id, { pinned: true })).toBe(true);
    state.status(ticket.worker_id, status);
    const worker = state.snapshot()[0]!;
    expect(worker).toMatchObject({ pinned: true, status, initial_prompt: { text: "Original input" }, steering: [{ id: "pending", status: "failed" }] });
    expect(worker.ended_at).toBeDefined();
    expect(worker.activity.at(-1)?.kind).toBe(`worker.${status}`);
    state.setPinned(ticket.worker_id, { pinned: true });
    expect(state.snapshot()).toHaveLength(1);
    state.setPinned(ticket.worker_id, { pinned: false });
    expect(state.snapshot()).toEqual([]);
    expect(state.setPinned(ticket.worker_id, { pinned: true })).toBe(false);
  });

  it.each(["running", "stopping", "stop_unverified"] as const)("unpinning %s still requires normal removal checks", (status) => {
    const state = new LocalWorkerState();
    const ticket = makeTicket();
    state.start(ticket);
    state.setPinned(ticket.worker_id, { pinned: true });
    state.status(ticket.worker_id, status);
    state.setPinned(ticket.worker_id, { pinned: false });
    expect(state.snapshot()[0]).toMatchObject({ status, pinned: false });
    state.status(ticket.worker_id, "stopped");
    expect(state.snapshot()).toEqual([]);
  });
});
