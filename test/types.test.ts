import { describe, expect, it } from "vitest";
import {
  isRecoverableOwnedTicket,
  ownedTicketSchema,
  ticketSchema
} from "../src/types.js";
import { makeTicket } from "./helpers.js";

describe("ticket execution profile", () => {
  it("accepts all supported configurable profile values", () => {
    expect(ticketSchema.safeParse(makeTicket({
      execution_mode: "HIGH",
      model: "gpt-5.6-sol",
      reasoning_effort: "ultra",
      service_tier: "default"
    })).success).toBe(true);
    expect(ticketSchema.safeParse(makeTicket({
      execution_mode: "FAST",
      model: "openai/future-model:preview_2",
      reasoning_effort: "max",
      service_tier: "priority"
    })).success).toBe(true);
  });

  it("trims model identifiers and enforces the shared 255-character boundary", () => {
    const namespaced = ticketSchema.parse(makeTicket({
      model: "  openai/gpt-5.6-sol:preview_2  "
    }));

    expect(namespaced.model).toBe("openai/gpt-5.6-sol:preview_2");
    expect(ticketSchema.safeParse(makeTicket({
      model: `g${"x".repeat(255)}`
    })).success).toBe(false);
    expect(ticketSchema.safeParse(makeTicket({
      model: "openai/gpt-5.6-sol?unsafe=true"
    })).success).toBe(false);
  });

  it.each([
    ["execution_mode", "TURBO"],
    ["model", "gpt model with spaces"],
    ["reasoning_effort", "extreme"],
    ["service_tier", "auto"]
  ])("rejects an invalid %s instead of using a worker-local fallback", (field, value) => {
    expect(ticketSchema.safeParse({
      ...makeTicket(),
      [field]: value
    }).success).toBe(false);
  });

  it.each([
    "execution_mode",
    "model",
    "reasoning_effort",
    "service_tier"
  ])("requires %s on every new ticket", (field) => {
    const ticket: Record<string, unknown> = { ...makeTicket() };
    delete ticket[field];
    expect(ticketSchema.safeParse(ticket).success).toBe(false);
  });

  it("does not recover an owned ticket until its complete snapshot is present", () => {
    const bareOwned = ownedTicketSchema.parse({
      ticket_id: "T-old",
      worker_id: "w-old",
      instructions: "Resume from history.",
      endpoints: makeTicket().endpoints
    });
    const completeOwned = ownedTicketSchema.parse(makeTicket());

    expect(isRecoverableOwnedTicket(bareOwned)).toBe(false);
    expect(isRecoverableOwnedTicket(completeOwned)).toBe(true);
  });

  it("parses the exact AI comment anchor for new and recovered tickets", () => {
    const newTicket = ticketSchema.parse(makeTicket({
      trigger_comment_id: 413,
      thread_anchor_comment_id: 412
    }));
    const recoveredTicket = ownedTicketSchema.parse(makeTicket({
      trigger_comment_id: 413,
      thread_anchor_comment_id: 412
    }));

    expect(newTicket.thread_anchor_comment_id).toBe(412);
    expect(recoveredTicket.thread_anchor_comment_id).toBe(412);
    expect(ticketSchema.parse(makeTicket({
      thread_anchor_comment_id: null
    })).thread_anchor_comment_id).toBeNull();
    expect(ticketSchema.safeParse(makeTicket({
      thread_anchor_comment_id: 0
    })).success).toBe(false);
  });
});
