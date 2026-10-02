import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const joinRoom = vi.fn();
const getRelaySockets = vi.fn<() => Record<string, FakeWebSocket>>(() => ({}));
const pauseRelayReconnection = vi.fn();
const resumeRelayReconnection = vi.fn();

vi.mock("trystero", () => ({
  getRelaySockets,
  joinRoom,
  pauseRelayReconnection,
  resumeRelayReconnection,
}));

vi.mock("../db/identity", () => ({
  randomId: vi.fn(() => "test-id"),
  roomIdFromSecret: vi.fn(async () => "test-room"),
  validPairingSecret: vi.fn(() => true),
}));

type FakeAction = {
  send: ReturnType<typeof vi.fn>;
  onMessage: ((data: unknown, context: { peerId: string }) => void | Promise<void>) | null;
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
    this.closeListeners.splice(0).forEach((listener) => listener());
  });
  private closeListeners: Array<() => void> = [];

  addEventListener(type: string, listener: () => void) {
    if (type === "close") this.closeListeners.push(listener);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
  }
}

function fakeRoom(peers: Record<string, { close: ReturnType<typeof vi.fn> }> = {}) {
  const actions = new Map<string, FakeAction>();
  return {
    actions,
    getPeers: vi.fn(() => peers),
    ping: vi.fn<(peerId: string) => Promise<number>>(),
    leave: vi.fn(async () => undefined),
    makeAction: vi.fn((namespace: string) => {
      let action = actions.get(namespace);
      if (!action) {
        action = { send: vi.fn(async () => undefined), onMessage: null };
        actions.set(namespace, action);
      }
      return action;
    }),
    onPeerJoin: null as ((peerId: string) => void) | null,
    onPeerLeave: null as ((peerId: string) => void) | null,
  };
}

const repository = {
  getSetting: vi.fn(async (_key: string, fallback: unknown) => fallback),
  setSetting: vi.fn(async () => undefined),
  snapshotOperations: vi.fn(async () => []),
  pendingOperations: vi.fn(async () => []),
  requeueStaleSending: vi.fn(async () => undefined),
  rememberPeer: vi.fn(async () => undefined),
  markPeerSynced: vi.fn(async () => undefined),
  acknowledgeOperations: vi.fn(async () => undefined),
  applyRemoteOperations: vi.fn(async () => []),
};

let SyncService: typeof import("./syncService").SyncService;

beforeAll(async () => {
  vi.stubGlobal("RTCPeerConnection", class {});
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("navigator", { onLine: true });
  ({ SyncService } = await import("./syncService"));
});

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getRelaySockets.mockReturnValue({});
});

describe("foreground WebRTC recovery", () => {
  it("deduplicates foreground signals and trusts a peer only after ping succeeds", async () => {
    const peer = { close: vi.fn() };
    const room = fakeRoom({ peer });
    room.ping.mockResolvedValue(42);
    const service = new SyncService(repository as never) as any;
    service.stopped = false;
    service.secret = "a".repeat(40);
    service.device = { deviceId: "device-a", label: "Phone A" };
    service.room = room;
    service.actions = { sendSyncControl: vi.fn(async () => []) };
    service.connectionGeneration = 1;
    service.handleHidden();

    await Promise.all([service.resumeConnection(), service.resumeConnection(), service.handleOnline()]);

    expect(room.ping).toHaveBeenCalledTimes(1);
    expect(room.leave).not.toHaveBeenCalled();
    expect(joinRoom).not.toHaveBeenCalled();
    service.stop();
  });

  it("closes and leaves a stale room before making one fresh join", async () => {
    const stalePeer = { close: vi.fn() };
    const stalePeers = { stale: stalePeer };
    stalePeer.close.mockImplementation(() => window.setTimeout(() => {
      delete (stalePeers as Partial<typeof stalePeers>).stale;
    }, 100));
    const staleRoom = fakeRoom(stalePeers);
    staleRoom.ping.mockImplementation(() => new Promise(() => undefined));
    const relays = { one: new FakeWebSocket(), two: new FakeWebSocket() };
    getRelaySockets.mockReturnValue(relays);
    let relayResumeCount = 0;
    resumeRelayReconnection.mockImplementation(() => {
      relayResumeCount += 1;
      if (relayResumeCount > 1) window.setTimeout(() => Object.values(relays).forEach((socket) => socket.open()), 200);
    });
    const freshPeer = { close: vi.fn() };
    const freshPeers: Record<string, { close: ReturnType<typeof vi.fn> }> = {};
    const freshRoom = fakeRoom(freshPeers);
    joinRoom.mockImplementation(() => {
      queueMicrotask(() => {
        freshPeers.fresh = freshPeer;
        freshRoom.onPeerJoin?.("fresh");
      });
      return freshRoom;
    });
    const service = new SyncService(repository as never) as any;
    service.stopped = false;
    service.secret = "b".repeat(40);
    service.device = { deviceId: "device-b", label: "Phone B" };
    service.room = staleRoom;
    service.actions = { sendSyncControl: vi.fn(async () => []) };
    service.connectionGeneration = 1;
    service.handleHidden();

    const resume = service.resumeConnection();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(joinRoom).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    await resume;

    expect(stalePeer.close).toHaveBeenCalledTimes(1);
    expect(staleRoom.leave).toHaveBeenCalledTimes(1);
    expect(relays.one.close).toHaveBeenCalledTimes(1);
    expect(relays.two.close).toHaveBeenCalledTimes(1);
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(service.room).toBe(freshRoom);
    service.stop();
  });

  it("keeps one fresh room stable for the full discovery window", async () => {
    const room = fakeRoom();
    const relays = { one: new FakeWebSocket(), two: new FakeWebSocket() };
    getRelaySockets.mockReturnValue(relays);
    resumeRelayReconnection.mockImplementation(() => Object.values(relays).forEach((socket) => socket.open()));
    joinRoom.mockReturnValue(room);
    const service = new SyncService(repository as never) as any;
    service.stopped = false;
    service.secret = "c".repeat(40);
    service.device = { deviceId: "device-c", label: "Phone C" };
    service.handleHidden();

    const resume = service.resumeConnection();
    await vi.advanceTimersByTimeAsync(8_000);
    await resume;

    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(room.leave).not.toHaveBeenCalled();
    expect(service.room).toBe(room);
    service.stop();
  });

  it("retries discovery after a full no-peer window instead of waiting for the 60s announce", async () => {
    const firstRoom = fakeRoom();
    const secondRoom = fakeRoom();
    joinRoom.mockReturnValueOnce(firstRoom).mockReturnValueOnce(secondRoom);
    const service = new SyncService(repository as never) as any;
    service.stopped = false;
    service.secret = "d".repeat(40);
    service.device = { deviceId: "device-d", label: "Phone D" };
    service.handleHidden();

    const firstResume = service.resumeConnection();
    await vi.advanceTimersByTimeAsync(8_000);
    await firstResume;
    expect(joinRoom).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(joinRoom).toHaveBeenCalledTimes(2);
    service.stop();
  });
});
