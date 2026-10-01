import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const joinRoom = vi.fn();

vi.mock("trystero", () => ({ joinRoom }));

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
    service.handleHidden();

    await Promise.all([service.resumeConnection(), service.resumeConnection(), service.handleOnline()]);

    expect(room.ping).toHaveBeenCalledTimes(1);
    expect(room.leave).not.toHaveBeenCalled();
    expect(joinRoom).not.toHaveBeenCalled();
    service.stop();
  });

  it("closes and leaves a stale room before making one fresh join", async () => {
    const stalePeer = { close: vi.fn() };
    const staleRoom = fakeRoom({ stale: stalePeer });
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

    const resume = service.resumeConnection();
    await vi.advanceTimersByTimeAsync(1_000);
    await resume;

    expect(stalePeer.close).toHaveBeenCalledTimes(1);
    expect(staleRoom.leave).toHaveBeenCalledTimes(1);
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(service.room).toBe(freshRoom);
    service.stop();
  });

  it("bounds a recovery burst to three 2.5-second fresh joins", async () => {
    const rooms = [fakeRoom(), fakeRoom(), fakeRoom()];
    joinRoom
      .mockReturnValueOnce(rooms[0])
      .mockReturnValueOnce(rooms[1])
      .mockReturnValueOnce(rooms[2]);
    const service = new SyncService(repository as never) as any;
    service.stopped = false;
    service.secret = "c".repeat(40);
    service.device = { deviceId: "device-c", label: "Phone C" };
    service.handleHidden();

    const resume = service.resumeConnection();
    await vi.advanceTimersByTimeAsync(8_000);
    await resume;

    expect(joinRoom).toHaveBeenCalledTimes(3);
    expect(rooms[0].leave).toHaveBeenCalledTimes(1);
    expect(rooms[1].leave).toHaveBeenCalledTimes(1);
    expect(rooms[2].leave).not.toHaveBeenCalled();
    expect(service.room).toBe(rooms[2]);
    service.stop();
  });
});
