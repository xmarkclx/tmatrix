import { describe, expect, it, vi } from "vitest";
import { prepareCodexInput } from "../src/prepare-codex-input.js";

const trustedImage =
  "/api/uploads/images/markdown-images/54/33333333-3333-4333-8333-333333333333.png";

describe("prepareCodexInput", () => {
  it("ignores remote and non-upload Markdown destinations without fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const prepared = await prepareCodexInput([
      "![remote](https://images.example.test/screenshot.png)",
      "![local file](/logo.png)",
      "![link](javascript:alert(1))"
    ].join("\n"), {
      origin: "https://tasks.example.test",
      fetch
    });

    expect(prepared.input).toBeTypeOf("string");
    expect(prepared.attachedImages).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    await prepared.cleanup();
  });

  it("skips invalid image responses without failing the text turn", async () => {
    const fetch = vi.fn(async () => new Response("not-an-image", {
      headers: { "content-type": "text/plain" }
    })) as typeof globalThis.fetch;
    const prepared = await prepareCodexInput(`![evidence](${trustedImage})`, {
      origin: "https://tasks.example.test",
      fetch
    });

    expect(prepared.input).toBeTypeOf("string");
    expect(prepared.attachedImages).toBe(0);
    expect(prepared.skippedImages).toBe(1);
    await prepared.cleanup();
  });

  it("skips a declared oversized upload before reading its body", async () => {
    const response = new Response("body", {
      headers: {
        "content-length": String(10 * 1024 * 1024 + 1),
        "content-type": "image/png"
      }
    });
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    const fetch = vi.fn(async () => response) as typeof globalThis.fetch;
    const prepared = await prepareCodexInput(`![large](${trustedImage})`, {
      origin: "https://tasks.example.test",
      fetch
    });

    expect(prepared.attachedImages).toBe(0);
    expect(prepared.skippedImages).toBe(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
    await prepared.cleanup();
  });
});
