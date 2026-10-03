import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlClient,
  type ControlSocket
} from "../src/control-client.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { makeCancellation, makeConfig } from "./helpers.js";

class FakeControlSocket extends EventEmitter {
  readyState = 0;
  readonly ping = vi.fn(() => undefined);
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readonly terminate = vi.fn(() => {
    this.finishClose();
  });

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {})
    });
    this.finishClose();
  }

  message(value: unknown, isBinary = false): void {
    this.emit("message", value, isBinary);
  }

  private finishClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", 1000, Buffer.alloc(0)));
  }

  asSocket(): ControlSocket {
    return this as unknown as ControlSocket;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ControlClient", () => {
  it("suspends push and reconnects on the next authorized poll without reviving stale sockets", async () => {
    vi.useFakeTimers();
    const sockets: FakeControlSocket[] = [];
    const createSocket = vi.fn(() => {
      const socket = new FakeControlSocket();
      sockets.push(socket);
      return socket.asSocket();
    });
    const onCancellation = vi.fn();
    const client = new ControlClient({
      config: makeConfig(), logger: nullLogger(), metrics: new Metrics(),
      onCancellation, createSocket
    });
    const url = "wss://tasks.example.test/api/v1/ai/events?instance_id=test-instance&swarm_id=test-swarm";
    client.updateUrl(url);
    sockets[0]!.open();
    client.suspend();
    sockets[0]!.message(Buffer.from(JSON.stringify(makeCancellation())));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createSocket).toHaveBeenCalledOnce();
    expect(onCancellation).not.toHaveBeenCalled();

    client.updateUrl(url);
    expect(createSocket).toHaveBeenCalledTimes(2);
    sockets[1]!.open();
    sockets[1]!.message(Buffer.from(JSON.stringify(makeCancellation())));
    expect(onCancellation).toHaveBeenCalledExactlyOnceWith(makeCancellation());

    await client.close();
    client.suspend();
    client.updateUrl(url);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createSocket).toHaveBeenCalledTimes(2);
  });

  it("authenticates by header and routes versioned cancellation messages", async () => {
    const socket = new FakeControlSocket();
    const createSocket = vi.fn((
      _url: string,
      _headers: Record<string, string>
    ) => socket.asSocket());
    const onCancellation = vi.fn();
    const metrics = new Metrics();
    const client = new ControlClient({
      config: makeConfig(),
      logger: nullLogger(),
      metrics,
      onCancellation,
      createSocket
    });

    const controlUrl =
      "wss://tasks.example.test/api/v1/ai/events?instance_id=test-instance&swarm_id=test-swarm";
    client.updateUrl(controlUrl);
    socket.open();
    socket.message(Buffer.from(JSON.stringify({ version: 1, kind: "connected" })));
    socket.message(Buffer.from(JSON.stringify({
      version: 1,
      kind: "cancellation-request",
      request: makeCancellation()
    })));

    expect(createSocket).toHaveBeenCalledOnce();
    expect(createSocket.mock.calls[0]?.[0]).toBe(
      controlUrl
    );
    expect(createSocket.mock.calls[0]?.[0]).not.toContain("test-secret-key");
    expect(createSocket.mock.calls[0]?.[1]).toMatchObject({
      "x-tzudo-identity-version": "3",
      authorization: "Bearer test-secret-key",
      "x-aiworker-instance": "test-instance",
      "x-aiworker-swarm": "test-swarm"
    });
    expect(onCancellation).toHaveBeenCalledExactlyOnceWith(makeCancellation());
    expect(
      (metrics.snapshot().counters as Record<string, number>)
        .control_messages_rejected
    ).toBe(0);

    await client.close();
  });

  it("rejects cross-origin, insecure, credential-bearing, and query URLs", async () => {
    const createSocket = vi.fn((
      _url: string,
      _headers: Record<string, string>
    ): ControlSocket => {
      throw new Error("Rejected URLs must not open a socket");
    });
    const metrics = new Metrics();
    const client = new ControlClient({
      config: makeConfig(),
      logger: nullLogger(),
      metrics,
      onCancellation: vi.fn(),
      createSocket
    });

    client.updateUrl(
      "ws://tasks.example.test/api/v1/ai/events?instance_id=test-instance&swarm_id=test-swarm"
    );
    client.updateUrl(
      "wss://attacker.example/api/v1/ai/events?instance_id=test-instance&swarm_id=test-swarm"
    );
    client.updateUrl(
      "wss://user:password@tasks.example.test/api/v1/ai/events?instance_id=test-instance&swarm_id=test-swarm"
    );
    client.updateUrl(
      "wss://tasks.example.test/api/ai/control?instance_id=test-instance&swarm_id=test-swarm"
    );
    client.updateUrl(
      "wss://tasks.example.test/api/v1/ai/events?instance_id=other&swarm_id=test-swarm"
    );
    client.updateUrl(
      "wss://tasks.example.test/api/v1/ai/events?instance_id=test-instance&swarm_id=other"
    );
    client.updateUrl(
      "wss://tasks.example.test/api/v1/ai/events?instance_id=test-instance&swarm_id=test-swarm&token=secret"
    );
    client.updateUrl(
      "wss://tasks.example.test/api/v1/ai/events?instance_id=test-instance&instance_id=test-instance&swarm_id=test-swarm"
    );

    expect(createSocket).not.toHaveBeenCalled();
    expect(
      (metrics.snapshot().counters as Record<string, number>)
        .control_url_rejected
    ).toBe(8);
    await client.close();
  });

  it("compares URL-decoded identity and permits an absent unconfigured swarm", async () => {
    const socket = new FakeControlSocket();
    const createSocket = vi.fn((
      _url: string,
      _headers: Record<string, string>
    ) => socket.asSocket());
    const client = new ControlClient({
      config: makeConfig({
        instance_id: "worker / one",
        swarm_id: undefined
      }),
      logger: nullLogger(),
      metrics: new Metrics(),
      onCancellation: vi.fn(),
      createSocket
    });

    client.updateUrl(
      "wss://tasks.example.test/api/v1/ai/events?instance_id=worker%20%2F%20one"
    );

    expect(createSocket).toHaveBeenCalledOnce();
    socket.open();
    await client.close();
  });

  it("reconnects with backoff and repeated poll URLs do not bypass it", async () => {
    vi.useFakeTimers();
    const sockets: FakeControlSocket[] = [];
    const createSocket = vi.fn((
      _url: string,
      _headers: Record<string, string>
    ) => {
      const socket = new FakeControlSocket();
      sockets.push(socket);
      return socket.asSocket();
    });
    const client = new ControlClient({
      config: makeConfig(),
      logger: nullLogger(),
      metrics: new Metrics(),
      onCancellation: vi.fn(),
      createSocket,
      random: () => 0
    });
    const url =
      "wss://tasks.example.test/api/v1/ai/events?instance_id=test-instance&swarm_id=test-swarm";

    client.updateUrl(url);
    sockets[0]?.open();
    sockets[0]?.close();
    await Promise.resolve();
    client.updateUrl(url);
    expect(createSocket).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(374);
    expect(createSocket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(createSocket).toHaveBeenCalledTimes(2);

    await client.close();
  });
});
