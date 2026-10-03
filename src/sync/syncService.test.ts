import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const adapterInstances = vi.hoisted(() => [] as Array<{
  isOpen: boolean;
  isReady: boolean;
  connect: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  requestCatchup: ReturnType<typeof vi.fn>;
  healthCheck: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  sendPresence: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  emit: (event: unknown) => void;
}>);

vi.mock("./cloudflareSyncAdapter", () => {
  class MockAdapter {
    isOpen = true;
    isReady = true;
    private listeners = new Set<(event: unknown) => void>();
    connect = vi.fn(async () => undefined);
    publish = vi.fn(async (events: Array<{ eventId: string }>) => events.map((event, index) => ({ eventId: event.eventId, sequence: index + 1 })));
    requestCatchup = vi.fn();
    healthCheck = vi.fn(async () => true);
    close = vi.fn();
    sendPresence = vi.fn();
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
  getSetting: vi.fn(async (_key: string, fallback: unknown) => fallback === false ? true : fallback),
  setSetting: vi.fn(async () => undefined),
  getLastAppliedSequence: vi.fn(async () => 0),
  snapshotOperations: vi.fn(async () => []),
  pendingOperations: vi.fn(async () => []),
  markSending: vi.fn(async () => undefined),
  requeueOperations: vi.fn(async () => undefined),
  requeueStaleSending: vi.fn(async () => undefined),
  rememberPeer: vi.fn(async () => undefined),
  markPeerSynced: vi.fn(async () => undefined),
  forgetPeer: vi.fn(async () => undefined),
  acknowledgeOperations: vi.fn(async () => undefined),
  applyRemoteEvents: vi.fn(async () => ({ lastAppliedSequence: 0, gap: false })),
  applyCheckpoint: vi.fn(async (_operations: unknown[], sequence: number) => sequence),
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

describe("Cloudflare WebSocket durable-log sync recovery", () => {
  const device = { id: "local" as const, deviceId: "device-a", createdAt: "2026-01-01T00:00:00.000Z", label: "Phone A" };

  it("connects one room immediately and remains connected when no peer is online", async () => {
    const service = new SyncService(repository as never);
    await service.start("a".repeat(40), device);
    expect(adapterInstances).toHaveLength(1);
    expect(adapterInstances[0].connect).toHaveBeenCalledWith({ roomId: "test-room", secret: "a".repeat(40), device, lastAppliedSequence: 0 });

    adapterInstances[0].emit({ type: "open", peers: [], latestSequence: 0, needsSnapshot: false });
    await Promise.resolve();
    expect((service as any).state.status).toBe("connected");
    expect((service as any).state.peerCount).toBe(0);
    service.stop();
  });

  it("records a later device as a room peer without starting a direct P2P handshake", async () => {
    const service = new SyncService(repository as never);
    await service.start("b".repeat(40), device);
    const adapter = adapterInstances[0];
    adapter.emit({ type: "open", peers: [], latestSequence: 0, needsSnapshot: false });
    adapter.emit({ type: "peerJoined", peer: { deviceId: "device-b", label: "Phone B" } });
    await Promise.resolve();

    expect(repository.rememberPeer).toHaveBeenCalledWith("device-b", "Phone B");
    expect(adapter.publish).not.toHaveBeenCalled();
    service.stop();
  });

  it("health-checks the existing socket after foreground resume and starts a catch-up handshake", async () => {
    const service = new SyncService(repository as never);
    await service.start("c".repeat(40), device);
    const adapter = adapterInstances[0];
    adapter.emit({ type: "open", peers: [{ deviceId: "device-b", label: "Phone B" }], latestSequence: 2, needsSnapshot: false });
    await Promise.resolve();
    service.handleHidden();
    await vi.advanceTimersByTimeAsync(1_000);
    await service.resumeConnection();

    expect(adapter.healthCheck).toHaveBeenCalledTimes(1);
    expect(adapter.requestCatchup).toHaveBeenCalledWith(0);
    expect(adapter.close).not.toHaveBeenCalled();
    service.stop();
  });

  it("reconnects after a WebSocket close and keeps retry state inside the adapter boundary", async () => {
    const service = new SyncService(repository as never);
    await service.start("d".repeat(40), device);
    const first = adapterInstances[0];
    first.emit({ type: "open", peers: [], latestSequence: 0, needsSnapshot: false });
    first.emit({ type: "close", code: 1006, reason: "network" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapterInstances).toHaveLength(2);
    expect(first.close).toHaveBeenCalled();
    service.stop();
  });
});
