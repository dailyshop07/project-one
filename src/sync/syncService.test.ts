import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const adapterInstances = vi.hoisted(() => [] as Array<{
  isOpen: boolean;
  connect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  healthCheck: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  emit: (event: unknown) => void;
}>);

vi.mock("./cloudflareSyncAdapter", () => {
  class MockAdapter {
    isOpen = true;
    private listeners = new Set<(event: unknown) => void>();
    connect = vi.fn(async () => undefined);
    send = vi.fn(async () => undefined);
    healthCheck = vi.fn(async () => true);
    close = vi.fn();
    subscribe = vi.fn((listener: (event: unknown) => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    });
    emit = (event: unknown) => this.listeners.forEach((listener) => listener(event));

    constructor() {
      adapterInstances.push(this);
    }
  }
  return {
    CloudflareSyncAdapter: MockAdapter,
    configuredCloudflareSyncEndpoint: () => "wss://sync.example.test",
  };
});

vi.mock("../db/identity", () => ({
  randomId: vi.fn(() => "test-id"),
  roomIdFromSecret: vi.fn(async () => "test-room"),
  validPairingSecret: vi.fn(() => true),
}));

const repository = {
  getSetting: vi.fn(async (_key: string, fallback: unknown) => fallback),
  setSetting: vi.fn(async () => undefined),
  snapshotOperations: vi.fn(async () => []),
  pendingOperations: vi.fn(async () => []),
  markSending: vi.fn(async () => undefined),
  requeueOperations: vi.fn(async () => undefined),
  requeueStaleSending: vi.fn(async () => undefined),
  rememberPeer: vi.fn(async () => undefined),
  markPeerSynced: vi.fn(async () => undefined),
  forgetPeer: vi.fn(async () => undefined),
  acknowledgeOperations: vi.fn(async () => undefined),
  applyRemoteOperations: vi.fn(async () => []),
};

let SyncService: typeof import("./syncService").SyncService;

beforeAll(async () => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { visibilityState: "visible", cookie: "" });
  vi.stubGlobal("navigator", { onLine: true });
  ({ SyncService } = await import("./syncService"));
});

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  adapterInstances.splice(0);
});

describe("Cloudflare WebSocket sync recovery", () => {
  const device = { id: "local" as const, deviceId: "device-a", createdAt: "2026-01-01T00:00:00.000Z", label: "Phone A" };

  it("connects one room immediately and waits for a peer without replacing the room", async () => {
    const service = new SyncService(repository as never);
    await service.start("a".repeat(40), device);
    expect(adapterInstances).toHaveLength(1);
    expect(adapterInstances[0].connect).toHaveBeenCalledWith({ roomId: "test-room", secret: "a".repeat(40), device });

    adapterInstances[0].emit({ type: "open", peers: [] });
    await vi.advanceTimersByTimeAsync(3_000);
    expect((service as any).state.status).toBe("pending");
    expect(adapterInstances).toHaveLength(1);
    service.stop();
  });

  it("discovers a later device and sends the existing snapshot handshake through the room", async () => {
    const service = new SyncService(repository as never);
    await service.start("b".repeat(40), device);
    const adapter = adapterInstances[0];
    adapter.emit({ type: "open", peers: [] });
    adapter.emit({ type: "peerJoined", peer: { deviceId: "device-b", label: "Phone B" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(repository.rememberPeer).toHaveBeenCalledWith("device-b", "Phone B");
    expect(adapter.send).toHaveBeenCalled();
    expect(adapter.send.mock.calls.some((call: unknown[]) => call[1] === "device-b")).toBe(true);
    service.stop();
  });

  it("health-checks the same WebSocket after foreground resume and requests a fresh snapshot", async () => {
    const service = new SyncService(repository as never);
    await service.start("c".repeat(40), device);
    const adapter = adapterInstances[0];
    adapter.emit({ type: "open", peers: [{ deviceId: "device-b", label: "Phone B" }] });
    await Promise.resolve();
    service.handleHidden();
    await vi.advanceTimersByTimeAsync(1_000);
    await service.resumeConnection();

    expect(adapter.healthCheck).toHaveBeenCalledTimes(1);
    expect(adapter.close).not.toHaveBeenCalled();
    service.stop();
  });

  it("reconnects after a WebSocket close and keeps the retry local to the adapter", async () => {
    const service = new SyncService(repository as never);
    await service.start("d".repeat(40), device);
    const first = adapterInstances[0];
    first.emit({ type: "open", peers: [] });
    first.emit({ type: "close", code: 1006, reason: "network" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapterInstances).toHaveLength(2);
    expect(first.close).toHaveBeenCalled();
    service.stop();
  });
});
