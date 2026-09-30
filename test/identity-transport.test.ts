import { describe, expect, it } from "vitest";
import { externalIdSchema, parseIdentityJson, stringifyIdentityJson } from "../src/identity-transport.js";
import { ownedTicketSchema, pollResponseSchema, steeringEventSchema, ticketSchema } from "../src/types.js";
import { makeTicket } from "./helpers.js";

describe("server identity compatibility", () => {
  it.each(["01994edd-45af-7baa-a478-628490a83d1a", "550e8400-e29b-41d4-a716-446655440000", 1500000000, 2000000000, Number.MAX_SAFE_INTEGER, "33736", "9007199254740993", "9223372036854775807"])(
    "retains the exact value and type of %s", (id) => {
      expect(externalIdSchema.parse(id)).toBe(id);
      const ticket = makeTicket({ task_id: id, trigger_comment_id: id, thread_anchor_comment_id: id });
      expect(ticketSchema.parse(ticket).task_id).toBe(id);
      expect(ownedTicketSchema.parse(ticket).thread_anchor_comment_id).toBe(id);
      expect(steeringEventSchema.parse({ worker_id: "worker-uuid", input_revision: 1, content: "Continue", trigger_comment_id: id }).trigger_comment_id).toBe(id);
      const wire = stringifyIdentityJson({ new_tickets: [ticket], history: { task: { id }, comments: [{ id, taskId: id }] } })!;
      const restored = parseIdentityJson(wire);
      expect(pollResponseSchema.parse(restored).new_tickets[0]?.task_id).toBe(id);
      expect(restored).toMatchObject({ history: { task: { id }, comments: [{ id, taskId: id }] } });
    }
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "", "0", "01", "-1", "+1", "1.0", "1e3", "0xff", "abc", "9223372036854775808", "1\n", "1\r\n"])(
    "rejects an invalid server identity %s", (id) => {
      expect(externalIdSchema.safeParse(id).success).toBe(false);
    }
  );

  it("refuses rounded nested history IDs before consumers see them", () => {
    expect(() => parseIdentityJson('{"comments":[{"id":9007199254740993}]}')).toThrow("Unsafe numeric identity");
    expect(() => parseIdentityJson('{"task":{"projectId":9223372036854775807}}')).toThrow("Unsafe numeric identity");
    expect(() => stringifyIdentityJson({ summary: { task_id: Number.MAX_SAFE_INTEGER + 1 } })).toThrow("Unsafe numeric identity");
  });

  it("preserves UUID identities, null relationships and non-ID quantities", () => {
    const value = { ticket_id: "ticket-uuid", task: { clientId: "client-uuid", parentId: null, order: 1.5 }, duration_ms: 0 };
    expect(parseIdentityJson(stringifyIdentityJson(value)!)).toEqual(value);
  });
});

// Untyped integration metadata can carry identities in plural arrays too.
it("rejects rounded plural identity arrays without disturbing exact strings", () => {
  expect(() => parseIdentityJson('{"taskIds":[9007199254740993]}')).toThrow("Unsafe numeric identity");
  expect(() => stringifyIdentityJson({ task_ids: [Number.MAX_SAFE_INTEGER + 1] })).toThrow("Unsafe numeric identity");
  expect(parseIdentityJson('{"taskIds":["9007199254740993","9223372036854775807"]}'))
    .toEqual({ taskIds: ["9007199254740993", "9223372036854775807"] });
});
