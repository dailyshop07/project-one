import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const joinRoom = vi.fn();

vi.mock("./trysteroFrameRoom", () => ({
  createTrysteroFrameRoom: joinRoom,
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

function fakeRoom(peers: Record<string, { close: ReturnType<typeof vi.fn> }> = {}) {
  const actions = new Map<string, FakeAction>();
  return {
    actions,
    getPeers: vi.fn(() => peers),
    ping: vi.fn<(peerId: string) => Promise<number>>(),
    leave: vi.fn(async () => undefined),
    terminate: vi.fn(() => Object.keys(peers).forEach((peerId) => delete peers[peerId])),
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
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("navigator", { onLine: true });
  ({ SyncService } = await import("./syncService"));
});

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
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

    await Promise.all([service.resumeConnection(), service.resumeConnection(), service.handleOnline()]);

    expect(room.ping).toHaveBeenCalledTimes(1);
    expect(room.terminate).not.toHaveBeenCalled();
    expect(joinRoom).not.toHaveBeenCalled();
    service.stop();
  });

  it("terminates the background transport realm before making one fresh join", async () => {
    const stalePeer = { close: vi.fn() };
    const stalePeers = { stale: stalePeer };
    stalePeer.close.mockImplementation(() => window.setTimeout(() => {
      delete (stalePeers as Partial<typeof stalePeers>).stale;
    }, 100));
    const staleRoom = fakeRoom(stalePeers);
    staleRoom.ping.mockImplementation(() => new Promise(() => undefined));
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

    expect(staleRoom.terminate).toHaveBeenCalledTimes(1);
    const resume = service.resumeConnection();
    await vi.advanceTimersByTimeAsync(1);
    await resume;

    expect(staleRoom.terminate).toHaveBeenCalledTimes(1);
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(service.room).toBe(freshRoom);
    service.stop();
  });

  it("starts a new discovery generation in under ten seconds when no peer appears", async () => {
    const room = fakeRoom();
    joinRoom.mockReturnValue(room);
    const service = new SyncService(repository as never) as any;
    service.stopped = false;
    service.secret = "c".repeat(40);
    service.device = { deviceId: "device-c", label: "Phone C" };
    service.handleHidden();

    const resume = service.resumeConnection();
    await vi.advanceTimersByTimeAsync(6_500);
    await resume;
    expect(joinRoom).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(joinRoom).toHaveBeenCalledTimes(2);
    expect(room.terminate).toHaveBeenCalledTimes(1);
    expect(service.room).toBe(room);
    service.stop();
  });

  it("restarts immediately when foregrounding interrupts an in-flight discovery", async () => {
    const firstRoom = fakeRoom();
    const secondPeers: Record<string, { close: ReturnType<typeof vi.fn> }> = {};
    const secondRoom = fakeRoom(secondPeers);
    joinRoom
      .mockReturnValueOnce(firstRoom)
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          secondPeers.peer = { close: vi.fn() };
          secondRoom.onPeerJoin?.("peer");
        });
        return secondRoom;
      });
    const service = new SyncService(repository as never) as any;
    service.stopped = false;
    service.secret = "d".repeat(40);
    service.device = { deviceId: "device-d", label: "Phone D" };

    const startup = service.runReconnectFlow("startup");
    await vi.advanceTimersByTimeAsync(1);
    service.handleHidden();
    const resume = service.resumeConnection();
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([startup, resume]);

    expect(firstRoom.terminate).toHaveBeenCalledTimes(1);
    expect(joinRoom).toHaveBeenCalledTimes(2);
    expect(service.room).toBe(secondRoom);
    service.stop();
  });

  it("does not tear down the startup room when focus fires during initial join", async () => {
    const room = fakeRoom();
    joinRoom.mockReturnValue(room);
    const service = new SyncService(repository as never) as any;
    service.stopped = false;
    service.secret = "e".repeat(40);
    service.device = { deviceId: "device-e", label: "Phone E" };
    service.iceServers = [];
    service.iceServersLoadedAt = Date.now();

    const startup = service.runReconnectFlow("startup");
    await Promise.resolve();
    const foreground = service.resumeConnection();
    await vi.advanceTimersByTimeAsync(6_500);
    await Promise.all([startup, foreground]);

    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(room.terminate).not.toHaveBeenCalled();
    expect(service.room).toBe(room);
    service.stop();
  });
});
