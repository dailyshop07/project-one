import { joinRoom, type Room } from "trystero";
import type { DeviceRecord, SyncOperation } from "../types";
import type { Repository } from "../db/repository";
import { randomId, roomIdFromSecret, validPairingSecret } from "../db/identity";
import { fetchTurnIceServers } from "./turnCredentials";
import { KeepPristineOfferPeerConnection } from "./rtcPolyfill";

export type SyncStatus = "local" | "offline" | "connecting" | "connected" | "syncing" | "pending" | "error";

const pendingPairingStorageKey = "project-one-pending-pairing-v1";
const pendingPairingCookieName = "project_one_pending_pairing_v1";
const pendingPairingMaxAgeMs = 24 * 60 * 60 * 1000;
const snapshotBatchSize = 50;
const pendingConnectionNoticeMs = 3_000;
const foregroundEventDebounceMs = 1_000;
const healthCheckTimeoutMs = 1_000;
const connectionWatchdogMs = 2_500;
const reconnectCleanupDelayMs = 200;
const maximumReconnectAttempts = 3;
const blockedPeerSettingKey = "sync.blocked-peer-ids.v1";
const disconnectedPeerSettingKey = "sync.disconnected-peer-ids.v1";

export interface SyncViewState {
  status: SyncStatus;
  peerCount: number;
  lastSyncedAt?: string;
  peerStatuses: Record<string, PeerStatus>;
}

export type PeerStatus = "connected" | "disconnected" | "unlinked" | "known";

type HelloMessage = { protocol: 1; deviceId: string; label: string };
type OperationsMessage = {
  protocol: 1;
  senderDeviceId: string;
  operations: SyncOperation[];
  snapshot?: boolean;
  snapshotId?: string;
  batchIndex?: number;
  batchCount?: number;
};
type SyncControlMessage =
  | { protocol: 1; type: "requestSnapshot"; senderDeviceId: string; requestId: string }
  | { protocol: 1; type: "snapshotComplete"; senderDeviceId: string; snapshotId: string; batchCount: number };
type AckMessage = { protocol: 1; senderDeviceId: string; operationIds: string[] };
type SendAction = (data: unknown, targetPeers?: string | string[] | null) => Promise<void[]>;
type ReceiveAction = (handler: (data: unknown, peerId: string) => void | Promise<void>) => () => void;
type ConnectionState = "disconnected" | "connecting" | "connected" | "recovering";
type ConnectionActions = {
  sendHello: SendAction;
  sendOperations: SendAction;
  sendAcknowledgements: SendAction;
  sendSyncControl: SendAction;
};

const isHello = (value: unknown): value is HelloMessage => {
  const message = value as Partial<HelloMessage>;
  return message?.protocol === 1 && typeof message.deviceId === "string" && typeof message.label === "string";
};

const isOperations = (value: unknown): value is OperationsMessage => {
  const message = value as Partial<OperationsMessage>;
  return message?.protocol === 1 && typeof message.senderDeviceId === "string" && Array.isArray(message.operations);
};

const isSyncControl = (value: unknown): value is SyncControlMessage => {
  const message = value as Partial<SyncControlMessage>;
  if (message?.protocol !== 1 || typeof message.senderDeviceId !== "string" || typeof message.type !== "string") return false;
  if (message.type === "requestSnapshot") return typeof message.requestId === "string";
  return message.type === "snapshotComplete" && typeof message.snapshotId === "string" && typeof message.batchCount === "number";
};

const isAck = (value: unknown): value is AckMessage => {
  const message = value as Partial<AckMessage>;
  return message?.protocol === 1 && typeof message.senderDeviceId === "string" && Array.isArray(message.operationIds);
};

function makeMessageAction(room: Room, namespace: string): [SendAction, ReceiveAction] {
  const action = room.makeAction<any>(namespace);
  return [
    (data, targetPeers) => action.send(data, { target: targetPeers }).then(() => []),
    (handler) => {
      const receiver = (data: unknown, context: { peerId: string }) => handler(data, context.peerId);
      action.onMessage = receiver;
      return () => {
        if (action.onMessage === receiver) action.onMessage = null;
      };
    },
  ];
}

export class SyncService {
  private room?: Room;
  private actions?: ConnectionActions;
  private actionCleanups: Array<() => void> = [];
  private currentPeers = new Set<string>();
  private connectionState: ConnectionState = "disconnected";
  private isConnecting = false;
  private reconnectAttempt = 0;
  private connectionGeneration = 0;
  private lastBackgroundAt?: number;
  private lastForegroundAt = 0;
  private listeners = new Set<(state: SyncViewState) => void>();
  private state: SyncViewState = { status: navigator.onLine ? "local" : "offline", peerCount: 0, peerStatuses: {} };
  private peerDevices = new Map<string, string>();
  private blockedPeerIds = new Set<string>();
  private disconnectedPeerIds = new Set<string>();
  private peerControlStateLoaded = false;
  private flushing = new Set<string>();
  private snapshotting = new Set<string>();
  private snapshotSynced = new Set<string>();
  private snapshotWaiters = new Map<string, { resolve: (complete: boolean) => void; timer: number }>();
  private incomingSnapshots = new Map<string, { batchCount: number; received: Set<number> }>();
  private device?: DeviceRecord;
  private secret?: string;
  private pendingTimer?: number;
  private deliveryTimer?: number;
  private peerReconnectTimer?: number;
  private reconnectPromise?: Promise<void>;
  private recoveryPromise?: Promise<void>;
  private connectionAttemptWaiter?: { generation: number; resolve: (connected: boolean) => void; timer: number };
  private stopped = false;
  private iceServers?: RTCIceServer[];
  private iceServersLoadedAt = 0;

  constructor(private readonly repository: Repository) {}

  subscribe(listener: (state: SyncViewState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<SyncViewState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }

  private log(message: string, ...details: unknown[]) {
    console.info(`[P2P] ${message}`, ...details);
  }

  private isCurrentConnection(room: Room, generation: number) {
    return this.room === room && this.connectionGeneration === generation && !this.stopped;
  }

  private peerStatuses(): Record<string, PeerStatus> {
    const statuses: Record<string, PeerStatus> = {};
    for (const deviceId of this.peerDevices.values()) statuses[deviceId] = "connected";
    for (const deviceId of this.disconnectedPeerIds) statuses[deviceId] = "disconnected";
    for (const deviceId of this.blockedPeerIds) statuses[deviceId] = "unlinked";
    return statuses;
  }

  private publishPeerStatuses() {
    this.setState({ peerStatuses: this.peerStatuses() });
  }

  private async loadPeerControlState() {
    if (this.peerControlStateLoaded) return;
    const [blocked, disconnected] = await Promise.all([
      this.repository.getSetting<unknown>(blockedPeerSettingKey, []),
      this.repository.getSetting<unknown>(disconnectedPeerSettingKey, []),
    ]);
    this.blockedPeerIds = new Set(Array.isArray(blocked) ? blocked.filter((value): value is string => typeof value === "string") : []);
    this.disconnectedPeerIds = new Set(Array.isArray(disconnected) ? disconnected.filter((value): value is string => typeof value === "string") : []);
    this.peerControlStateLoaded = true;
    this.publishPeerStatuses();
  }

  private async savePeerControlState() {
    await Promise.all([
      this.repository.setSetting(blockedPeerSettingKey, Array.from(this.blockedPeerIds)),
      this.repository.setSetting(disconnectedPeerSettingKey, Array.from(this.disconnectedPeerIds)),
    ]);
  }

  private transportPeerIdFor(deviceId: string) {
    for (const [peerId, knownDeviceId] of this.peerDevices) {
      if (knownDeviceId === deviceId) return peerId;
    }
    return undefined;
  }

  private closeTransportPeer(peerId?: string) {
    if (!peerId) return;
    try {
      this.room?.getPeers()[peerId]?.close();
    } catch {
      // The connection may already have been closed by the browser.
    }
  }

  private shouldRejectPeer(deviceId: string) {
    return this.blockedPeerIds.has(deviceId) || this.disconnectedPeerIds.has(deviceId);
  }

  private clearConnectionTimers() {
    if (this.pendingTimer !== undefined) window.clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
  }

  private clearPeerReconnectTimer() {
    if (this.peerReconnectTimer !== undefined) window.clearTimeout(this.peerReconnectTimer);
    this.peerReconnectTimer = undefined;
  }

  private delay(milliseconds: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
  }

  private schedulePeerReconnect() {
    if (this.peerReconnectTimer !== undefined || this.stopped || !navigator.onLine || document.visibilityState === "hidden") return;
    this.peerReconnectTimer = window.setTimeout(() => {
      this.peerReconnectTimer = undefined;
      if (!this.currentPeers.size && document.visibilityState !== "hidden") {
        void this.runReconnectFlow("peer left");
      }
    }, reconnectCleanupDelayMs);
  }

  private clearDeliveryTimer() {
    if (this.deliveryTimer !== undefined) window.clearInterval(this.deliveryTimer);
    this.deliveryTimer = undefined;
  }

  private startDeliveryWatch() {
    if (this.deliveryTimer !== undefined) return;
    this.deliveryTimer = window.setInterval(() => void this.retryDelivery(), 2_500);
  }

  private async retryDelivery() {
    if (!this.room || !this.device || !this.actions) return;
    const generation = this.connectionGeneration;
    const peerIds = Object.keys(this.room.getPeers());
    if (!peerIds.length) return;
    await this.repository.requeueStaleSending(4_000);
    if (generation !== this.connectionGeneration || !this.actions) return;
    const { sendOperations } = this.actions;
    await Promise.all(peerIds.map(async (peerId) => {
      await this.sendSnapshotToPeer(peerId, sendOperations, false, generation);
      await this.flushToPeer(peerId, sendOperations, generation);
    }));
  }

  private snapshotWaiterKey(peerId: string, snapshotId: string) {
    return `${peerId}:${snapshotId}`;
  }

  private resolveSnapshot(peerId: string, snapshotId: string, complete: boolean) {
    const key = this.snapshotWaiterKey(peerId, snapshotId);
    const waiter = this.snapshotWaiters.get(key);
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    this.snapshotWaiters.delete(key);
    waiter.resolve(complete);
  }

  private clearSnapshotWaitersForPeer(peerId: string) {
    const prefix = `${peerId}:`;
    for (const [key, waiter] of this.snapshotWaiters) {
      if (!key.startsWith(prefix)) continue;
      window.clearTimeout(waiter.timer);
      this.snapshotWaiters.delete(key);
      waiter.resolve(false);
    }
  }

  private clearSnapshotState() {
    for (const waiter of this.snapshotWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.snapshotWaiters.clear();
    this.incomingSnapshots.clear();
  }

  private async getIceServers() {
    const sixHoursMs = 6 * 60 * 60 * 1000;
    if (this.iceServersLoadedAt && Date.now() - this.iceServersLoadedAt < sixHoursMs) return this.iceServers;
    this.iceServers = await fetchTurnIceServers();
    this.iceServersLoadedAt = Date.now();
    return this.iceServers;
  }

  private async requestFreshSnapshots(generation = this.connectionGeneration) {
    if (!this.room || !this.device || !this.actions || generation !== this.connectionGeneration) return;
    const peerIds = Object.keys(this.room.getPeers());
    if (!peerIds.length) return;
    const { sendSyncControl } = this.actions;
    this.log("sync started");
    await Promise.allSettled(peerIds.map((peerId) => sendSyncControl({
      protocol: 1,
      type: "requestSnapshot",
      senderDeviceId: this.device!.deviceId,
      requestId: randomId(),
    } as SyncControlMessage, peerId)));
    if (generation === this.connectionGeneration) this.log("sync request sent");
  }

  private async sendSnapshotToPeer(peerId: string, sendAction: SendAction, force = false, generation = this.connectionGeneration) {
    // A requestSnapshot comes from the peer that needs bootstrap data. It
    // must win over the in-memory optimization, even if this transport peer
    // id was reused after another connection or a previous handshake.
    const snapshottingKey = `${generation}:${peerId}`;
    if (!this.device || generation !== this.connectionGeneration || this.snapshotting.has(snapshottingKey) || (!force && this.snapshotSynced.has(peerId))) return;
    this.snapshotting.add(snapshottingKey);
    this.setState({ status: "syncing" });
    const snapshotId = randomId();
    const waiterKey = this.snapshotWaiterKey(peerId, snapshotId);
    const completion = new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        this.snapshotWaiters.delete(waiterKey);
        resolve(false);
      }, 15_000);
      this.snapshotWaiters.set(waiterKey, { resolve, timer });
    });
    try {
      const operations = await this.repository.snapshotOperations();
      if (generation !== this.connectionGeneration) {
        this.resolveSnapshot(peerId, snapshotId, false);
        return;
      }
      const batches = operations.length
        ? Array.from(
            { length: Math.ceil(operations.length / snapshotBatchSize) },
            (_, index) => operations.slice(index * snapshotBatchSize, (index + 1) * snapshotBatchSize),
          )
        : [[]];
      for (const [batchIndex, batch] of batches.entries()) {
        if (generation !== this.connectionGeneration || !this.room || !Object.keys(this.room.getPeers()).includes(peerId)) {
          this.resolveSnapshot(peerId, snapshotId, false);
          return;
        }
        await sendAction({
          protocol: 1,
          senderDeviceId: this.device.deviceId,
          operations: batch,
          snapshot: true,
          snapshotId,
          batchIndex,
          batchCount: batches.length,
        } as OperationsMessage, peerId);
      }
      if (await completion && generation === this.connectionGeneration) {
        this.snapshotSynced.add(peerId);
        this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
        this.log("sync completed");
      } else if (generation === this.connectionGeneration) {
        this.setState({ status: navigator.onLine ? "pending" : "offline" });
      }
    } catch {
      this.resolveSnapshot(peerId, snapshotId, false);
      if (generation === this.connectionGeneration) this.setState({ status: navigator.onLine ? "pending" : "offline" });
    } finally {
      this.snapshotting.delete(snapshottingKey);
    }
  }

  private scheduleConnectionNotice() {
    if (this.stopped || !navigator.onLine || !this.secret || !this.device) return;
    if (this.room && this.pendingTimer === undefined) {
      this.pendingTimer = window.setTimeout(() => {
        this.pendingTimer = undefined;
        if (this.room && !this.currentPeers.size) this.setState({ status: navigator.onLine ? "pending" : "offline", peerCount: 0 });
      }, pendingConnectionNoticeMs);
    }
  }

  private resolveConnectionAttempt(generation: number, connected: boolean) {
    const waiter = this.connectionAttemptWaiter;
    if (!waiter || waiter.generation !== generation) return;
    window.clearTimeout(waiter.timer);
    this.connectionAttemptWaiter = undefined;
    waiter.resolve(connected);
  }

  private async destroyCurrentConnection(expectedRoom?: Room) {
    if (expectedRoom && this.room !== expectedRoom) return;
    const room = this.room;
    if (!room) {
      this.connectionState = "disconnected";
      return;
    }

    this.log("destroying old room");
    this.connectionGeneration += 1;
    this.resolveConnectionAttempt(this.connectionGeneration - 1, false);
    this.clearConnectionTimers();
    this.clearPeerReconnectTimer();
    this.clearSnapshotState();
    this.room = undefined;
    this.actions = undefined;
    this.actionCleanups.splice(0).forEach((cleanup) => cleanup());
    room.onPeerJoin = null;
    room.onPeerLeave = null;
    const peers = Object.values(room.getPeers?.() ?? {});
    this.log(`closing ${peers.length} peer connection${peers.length === 1 ? "" : "s"}`);
    for (const peer of peers) {
      try {
        peer.close?.();
      } catch {
        // The browser may already have disposed a stale iOS connection.
      }
    }
    this.currentPeers.clear();
    this.peerDevices.clear();
    this.flushing.clear();
    this.snapshotting.clear();
    this.snapshotSynced.clear();
    this.connectionState = "disconnected";
    this.setState({ status: navigator.onLine ? "connecting" : "offline", peerCount: 0, peerStatuses: this.peerStatuses() });
    try {
      await room.leave?.();
    } catch {
      // Explicit peer close already detached the transport; leave is best effort.
    }
  }

  private waitForPeer(room: Room, generation: number) {
    if (!this.isCurrentConnection(room, generation)) return Promise.resolve(false);
    if (this.currentPeers.size || Object.keys(room.getPeers()).length) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.connectionAttemptWaiter?.generation === generation) this.connectionAttemptWaiter = undefined;
        resolve(false);
      }, connectionWatchdogMs);
      this.connectionAttemptWaiter = { generation, resolve, timer };
    });
  }

  private async connectFresh(attempt: number) {
    const secret = this.secret;
    const device = this.device;
    if (this.stopped || !navigator.onLine || !secret || !device) return false;
    const generation = ++this.connectionGeneration;
    this.connectionState = attempt === 1 ? "connecting" : "recovering";
    this.log(`joining room generation ${generation} attempt ${attempt}`);
    this.setState({ status: "connecting", peerStatuses: this.peerStatuses() });
    const [roomId, iceServers] = await Promise.all([roomIdFromSecret(secret), this.getIceServers()]);
    if (generation !== this.connectionGeneration || this.stopped || !navigator.onLine || this.secret !== secret || this.device?.deviceId !== device.deviceId) return false;
    const joinedAt = Date.now();
    const room = joinRoom(
      {
        appId: "project-one-p2p-v1",
        password: secret,
        ...(iceServers?.length ? { rtcConfig: { iceServers } } : {}),
        // Keep signaling focused on the relays that accept this app's encrypted events.
        // The package defaults currently include public relays that reject writes,
        // which creates noisy retries before the phones can see each other.
        relayConfig: {
          urls: [
            "wss://nos.lol",
            "wss://relay.nostrdice.com",
            "wss://nostr.sathoarder.com",
            "wss://nostr.tegila.com.br",
            "wss://relay.agorist.space",
            "wss://nostr.vulpem.com",
          ],
        },
        rtcPolyfill: KeepPristineOfferPeerConnection,
      },
      roomId,
      {
        onJoinError: () => {
          if (generation !== this.connectionGeneration || this.stopped) return;
          this.log(`join error generation ${generation}`);
          this.setState({ status: navigator.onLine ? "error" : "offline" });
          this.resolveConnectionAttempt(generation, false);
        },
      },
    );
    this.room = room;
    this.currentPeers.clear();
    this.startDeliveryWatch();
    const [sendHello, onHello] = makeMessageAction(room, "hello");
    const [sendOperations, onOperations] = makeMessageAction(room, "operations");
    const [sendAcknowledgements, onAcknowledgements] = makeMessageAction(room, "acks");
    const [sendSyncControl, onSyncControl] = makeMessageAction(room, "sync");
    this.actions = { sendHello, sendOperations, sendAcknowledgements, sendSyncControl };
    const announcePeer = async (peerId: string) => {
      if (!this.isCurrentConnection(room, generation)) return;
      this.log("sync started", peerId);
      try {
        await sendHello({ protocol: 1, deviceId: device.deviceId, label: device.label }, peerId);
        await sendSyncControl({ protocol: 1, type: "requestSnapshot", senderDeviceId: device.deviceId, requestId: randomId() } as SyncControlMessage, peerId);
        await this.sendSnapshotToPeer(peerId, sendOperations, true, generation);
        await this.flushToPeer(peerId, sendOperations, generation);
      } catch {
        if (generation === this.connectionGeneration) this.setState({ status: navigator.onLine ? "pending" : "offline" });
      }
    };

    room.onPeerJoin = (peerId) => {
      if (!this.isCurrentConnection(room, generation)) return;
      this.currentPeers.add(peerId);
      this.connectionState = "connected";
      this.clearConnectionTimers();
      this.clearPeerReconnectTimer();
      this.setState({ status: "connected", peerCount: this.currentPeers.size });
      this.log(`peer joined after ${Date.now() - joinedAt}ms`);
      this.resolveConnectionAttempt(generation, true);
      void announcePeer(peerId);
    };

    room.onPeerLeave = (peerId) => {
      if (!this.isCurrentConnection(room, generation)) return;
      const deviceId = this.peerDevices.get(peerId);
      this.currentPeers.delete(peerId);
      this.peerDevices.delete(peerId);
      this.snapshotting.delete(`${generation}:${peerId}`);
      this.snapshotSynced.delete(peerId);
      this.clearSnapshotWaitersForPeer(peerId);
      for (const key of this.incomingSnapshots.keys()) if (key.startsWith(`${peerId}:`)) this.incomingSnapshots.delete(key);
      const peerCount = this.currentPeers.size;
      if (!peerCount) this.connectionState = "disconnected";
      this.setState({ status: peerCount ? "connected" : navigator.onLine ? "pending" : "offline", peerCount, peerStatuses: this.peerStatuses() });
      this.log(`peer left; ${peerCount} peer${peerCount === 1 ? "" : "s"} remain`);
      if (!peerCount && navigator.onLine && (!deviceId || !this.shouldRejectPeer(deviceId))) this.schedulePeerReconnect();
    };

    this.actionCleanups.push(onHello((message: unknown, peerId: string) => {
      if (!this.isCurrentConnection(room, generation)) return;
      if (!isHello(message) || message.deviceId === device.deviceId) return;
      this.peerDevices.set(peerId, message.deviceId);
      if (this.shouldRejectPeer(message.deviceId)) {
        this.closeTransportPeer(peerId);
        this.publishPeerStatuses();
        return;
      }
      void (async () => {
        await this.repository.rememberPeer(message.deviceId, message.label);
        if (!this.isCurrentConnection(room, generation)) return;
        await this.sendSnapshotToPeer(peerId, sendOperations, false, generation);
        await this.flushToPeer(peerId, sendOperations, generation);
        if (this.isCurrentConnection(room, generation)) this.publishPeerStatuses();
      })();
    }));

    this.actionCleanups.push(onSyncControl((message: unknown, peerId: string) => {
      if (!this.isCurrentConnection(room, generation)) return;
      if (!isSyncControl(message) || message.senderDeviceId === device.deviceId) return;
      if (this.shouldRejectPeer(message.senderDeviceId)) {
        this.closeTransportPeer(peerId);
        return;
      }
      if (message.type === "snapshotComplete") {
        this.resolveSnapshot(peerId, message.snapshotId, true);
        return;
      }
      void (async () => {
        await this.sendSnapshotToPeer(peerId, sendOperations, true, generation);
        await this.flushToPeer(peerId, sendOperations, generation);
      })();
    }));

    this.actionCleanups.push(onOperations(async (message: unknown, peerId: string) => {
      if (!this.isCurrentConnection(room, generation)) return;
      if (!isOperations(message) || message.senderDeviceId === device.deviceId) return;
      if (this.shouldRejectPeer(message.senderDeviceId)) {
        this.closeTransportPeer(peerId);
        return;
      }
      try {
        this.setState({ status: "syncing" });
        const operationIds = await this.repository.applyRemoteOperations(message.operations);
        if (!this.isCurrentConnection(room, generation)) return;
        await sendAcknowledgements(
          { protocol: 1, senderDeviceId: device.deviceId, operationIds },
          peerId,
        );
        const snapshotId = message.snapshotId;
        const batchIndex = message.batchIndex;
        const batchCount = message.batchCount;
        if (message.snapshot && snapshotId !== undefined && typeof batchIndex === "number" && Number.isInteger(batchIndex) && typeof batchCount === "number" && Number.isInteger(batchCount) && batchCount > 0) {
          const snapshotKey = this.snapshotWaiterKey(peerId, snapshotId);
          const progress = this.incomingSnapshots.get(snapshotKey) ?? { batchCount, received: new Set<number>() };
          progress.received.add(batchIndex);
          this.incomingSnapshots.set(snapshotKey, progress);
          if (progress.received.size >= progress.batchCount) {
            this.incomingSnapshots.delete(snapshotKey);
            await sendSyncControl({ protocol: 1, type: "snapshotComplete", senderDeviceId: device.deviceId, snapshotId, batchCount: progress.batchCount } as SyncControlMessage, peerId);
          }
        }
        await this.repository.markPeerSynced(message.senderDeviceId);
        if (this.isCurrentConnection(room, generation)) this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
      } catch {
        // Do not acknowledge a failed batch. The sender will time out and
        // retry the snapshot, while the live connection remains usable.
        if (generation === this.connectionGeneration) this.setState({ status: navigator.onLine ? "pending" : "offline" });
      }
    }));

    this.actionCleanups.push(onAcknowledgements(async (message: unknown, peerId: string) => {
      if (!this.isCurrentConnection(room, generation)) return;
      if (!isAck(message) || message.senderDeviceId === device.deviceId) return;
      if (this.shouldRejectPeer(message.senderDeviceId)) {
        this.closeTransportPeer(peerId);
        return;
      }
      await this.repository.acknowledgeOperations(message.operationIds);
      await this.repository.markPeerSynced(message.senderDeviceId);
      if (!this.isCurrentConnection(room, generation)) return;
      this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
      await this.flushToPeer(peerId, sendOperations, generation);
    }));

    const peers = Object.keys(room.getPeers());
    peers.forEach((peerId) => this.currentPeers.add(peerId));
    this.setState({ status: peers.length ? "connected" : "connecting", peerCount: peers.length, peerStatuses: this.peerStatuses() });
    if (peers.length) {
      this.connectionState = "connected";
      peers.forEach((peerId) => void announcePeer(peerId));
    } else {
      this.scheduleConnectionNotice();
    }
    return this.waitForPeer(room, generation);
  }

  private runReconnectFlow(reason: string) {
    if (this.reconnectPromise) return this.reconnectPromise;
    if (this.stopped || !navigator.onLine || !this.secret || !this.device) return Promise.resolve();
    const secret = this.secret;
    const deviceId = this.device.deviceId;
    const flow = (async () => {
      this.isConnecting = true;
      this.connectionState = "recovering";
      this.log(`starting controlled reconnect: ${reason}`);
      for (let attempt = 1; attempt <= maximumReconnectAttempts; attempt += 1) {
        if (this.stopped || !navigator.onLine || this.secret !== secret || this.device?.deviceId !== deviceId) return;
        this.reconnectAttempt = attempt;
        await this.destroyCurrentConnection();
        if (attempt > 1) await this.delay(reconnectCleanupDelayMs);
        try {
          if (await this.connectFresh(attempt)) return;
        } catch (error) {
          this.log(`join attempt ${attempt} failed`, error);
        }
        this.log(`connect timeout after ${connectionWatchdogMs}ms`);
        if (attempt < maximumReconnectAttempts) this.log("retrying fresh connection");
      }
      // Keep the third fresh room subscribed after the bounded recovery flow.
      // This preserves cold-start discovery when the other phone opens later,
      // without creating a leave/join loop in the foreground.
      this.connectionState = this.room ? "connecting" : "disconnected";
      this.setState({ status: navigator.onLine ? "pending" : "offline", peerCount: 0 });
    })();
    this.reconnectPromise = flow;
    void flow.finally(() => {
      if (this.reconnectPromise === flow) this.reconnectPromise = undefined;
      this.isConnecting = false;
      this.reconnectAttempt = 0;
    });
    return flow;
  }

  async start(secret: string, device: DeviceRecord) {
    if (!validPairingSecret(secret)) return;
    if (this.room || this.reconnectPromise) return this.reconnectPromise;
    this.stopped = false;
    this.secret = secret;
    this.device = device;
    await this.loadPeerControlState();
    if (!navigator.onLine) {
      this.setState({ status: "offline", peerStatuses: this.peerStatuses() });
      return;
    }
    await this.runReconnectFlow("startup");
  }

  private async flushToPeer(peerId: string, sendAction: SendAction, generation = this.connectionGeneration) {
    const flushingKey = `${generation}:${peerId}`;
    if (!this.device || generation !== this.connectionGeneration || this.flushing.has(flushingKey)) return;
    this.flushing.add(flushingKey);
    try {
      while (true) {
        const pending = await this.repository.pendingOperations(50);
        if (generation !== this.connectionGeneration) return;
        if (!pending.length) return;
        const ids = pending.map((operation) => operation.operationId);
        await this.repository.markSending(ids);
        this.setState({ status: "syncing" });
        try {
          await sendAction(
            { protocol: 1, senderDeviceId: this.device.deviceId, operations: pending } as OperationsMessage,
            peerId,
          );
        } catch {
          await this.repository.requeueOperations(ids);
          if (generation === this.connectionGeneration) this.setState({ status: navigator.onLine ? "pending" : "offline" });
          return;
        }
      }
    } finally {
      this.flushing.delete(flushingKey);
    }
  }

  async notifyLocalChange() {
    if (!this.room || !this.device || !this.actions) {
      this.setState({ status: navigator.onLine ? "local" : "offline" });
      return;
    }
    const generation = this.connectionGeneration;
    await Promise.all(Object.keys(this.room.getPeers()).map((peerId) => this.flushToPeer(peerId, this.actions!.sendOperations, generation)));
  }

  async updateDeviceLabel(label: string) {
    if (!this.device || !this.room || !this.actions) return;
    this.device = { ...this.device, label };
    await Promise.all(Object.keys(this.room.getPeers()).map((peerId) => this.actions!.sendHello({ protocol: 1, deviceId: this.device!.deviceId, label }, peerId)));
  }

  async disconnectPeer(deviceId: string) {
    if (!deviceId || deviceId === this.device?.deviceId) return;
    await this.loadPeerControlState();
    this.disconnectedPeerIds.add(deviceId);
    this.blockedPeerIds.delete(deviceId);
    await this.savePeerControlState();
    this.closeTransportPeer(this.transportPeerIdFor(deviceId));
    this.publishPeerStatuses();
  }

  async reconnectPeer(deviceId: string) {
    if (!deviceId || deviceId === this.device?.deviceId) return;
    await this.loadPeerControlState();
    this.disconnectedPeerIds.delete(deviceId);
    await this.savePeerControlState();
    this.publishPeerStatuses();
    if (navigator.onLine) await this.handleOnline(true);
  }

  async unlinkPeer(deviceId: string) {
    if (!deviceId || deviceId === this.device?.deviceId) return;
    await this.loadPeerControlState();
    this.blockedPeerIds.add(deviceId);
    this.disconnectedPeerIds.delete(deviceId);
    await this.savePeerControlState();
    this.closeTransportPeer(this.transportPeerIdFor(deviceId));
    this.publishPeerStatuses();
  }

  async allowPeer(deviceId: string) {
    if (!deviceId || deviceId === this.device?.deviceId) return;
    await this.loadPeerControlState();
    this.blockedPeerIds.delete(deviceId);
    this.disconnectedPeerIds.delete(deviceId);
    await this.savePeerControlState();
    this.publishPeerStatuses();
    if (navigator.onLine) await this.handleOnline(true);
  }

  async clearPeerRecord(deviceId: string) {
    if (!deviceId || deviceId === this.device?.deviceId) return;
    await this.loadPeerControlState();
    this.blockedPeerIds.delete(deviceId);
    this.disconnectedPeerIds.delete(deviceId);
    await this.savePeerControlState();
    await this.repository.forgetPeer(deviceId);
    this.publishPeerStatuses();
  }

  private async checkExistingPeer() {
    const room = this.room;
    if (!room) return false;
    const generation = this.connectionGeneration;
    const peerIds = Object.keys(room.getPeers());
    if (!peerIds.length) return false;
    this.log("checking existing peer");
    const startedAt = Date.now();
    let settled = false;
    return new Promise<boolean>((resolve) => {
      const finish = (healthy: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(healthy && this.isCurrentConnection(room, generation));
      };
      const timer = window.setTimeout(() => finish(false), healthCheckTimeoutMs);
      for (const peerId of peerIds) {
        this.log("ping sent", peerId);
        void room.ping(peerId).then(() => {
          if (!this.isCurrentConnection(room, generation)) return finish(false);
          this.log(`pong received in ${Date.now() - startedAt}ms`, peerId);
          finish(true);
        }).catch(() => {
          // Another peer may still answer before the shared one-second timeout.
        });
      }
    });
  }

  private recoverConnection(reason: string, forceFresh = false) {
    if (this.recoveryPromise) return this.recoveryPromise;
    if (this.stopped || !navigator.onLine || !this.secret || !this.device) return Promise.resolve();
    const recovery = (async () => {
      const activeFlow = this.reconnectPromise;
      if (activeFlow) {
        await activeFlow;
        return;
      }
      if (this.stopped || !navigator.onLine) return;
      if (!forceFresh && await this.checkExistingPeer()) {
        this.connectionState = "connected";
        this.currentPeers = new Set(Object.keys(this.room?.getPeers() ?? {}));
        this.clearConnectionTimers();
        this.setState({ status: "connected", peerCount: this.currentPeers.size });
        await this.requestFreshSnapshots();
        return;
      }
      this.log(this.room ? "stale connection detected" : "no active room detected");
      await this.runReconnectFlow(reason);
    })();
    this.recoveryPromise = recovery;
    void recovery.finally(() => {
      if (this.recoveryPromise === recovery) this.recoveryPromise = undefined;
    });
    return recovery;
  }

  async resumeConnection() {
    const now = Date.now();
    const backgroundDuration = this.lastBackgroundAt === undefined ? 0 : now - this.lastBackgroundAt;
    if (now - this.lastForegroundAt < foregroundEventDebounceMs) return this.recoveryPromise ?? this.reconnectPromise;
    this.lastForegroundAt = now;
    this.lastBackgroundAt = undefined;
    this.log(`app foregrounded after ${backgroundDuration}ms`);
    return this.recoverConnection("foreground resume");
  }

  async handleOnline(forceReconnect = false) {
    await this.recoverConnection(forceReconnect ? "manual reconnect" : "network online", forceReconnect);
  }

  handleHidden() {
    if (this.lastBackgroundAt === undefined) {
      this.lastBackgroundAt = Date.now();
      this.log("app backgrounded");
    }
    // The next visible signal starts a new foreground burst; subsequent
    // pageshow/focus/resume signals from that same burst are deduplicated.
    this.lastForegroundAt = 0;
    this.clearPeerReconnectTimer();
  }

  handleOffline() {
    this.clearConnectionTimers();
    this.clearPeerReconnectTimer();
    this.connectionState = "disconnected";
    this.setState({ status: "offline", peerCount: 0 });
  }

  stop() {
    this.stopped = true;
    this.clearConnectionTimers();
    this.clearPeerReconnectTimer();
    this.clearDeliveryTimer();
    this.clearSnapshotState();
    this.lastBackgroundAt = undefined;
    const room = this.room;
    if (room) {
      void this.destroyCurrentConnection(room);
    } else {
      const generation = this.connectionGeneration;
      this.connectionGeneration += 1;
      this.resolveConnectionAttempt(generation, false);
    }
    this.setState({ status: navigator.onLine ? "local" : "offline", peerCount: 0, peerStatuses: this.peerStatuses() });
  }
}

export function pairingSecretFromLocation() {
  const url = new URL(location.href);
  const value = new URLSearchParams(url.hash.replace(/^#/, "")).get("pair") ?? url.searchParams.get("pair");
  return validPairingSecret(value) ? value : undefined;
}

export function pendingPairingSecretFromStorage() {
  let storedSecret: string | undefined;
  try {
    const raw = localStorage.getItem(pendingPairingStorageKey);
    if (raw) {
      const value = JSON.parse(raw) as { secret?: string; savedAt?: number };
      if (validPairingSecret(value.secret ?? null) && value.savedAt && Date.now() - value.savedAt <= pendingPairingMaxAgeMs) {
        storedSecret = value.secret;
      } else {
        localStorage.removeItem(pendingPairingStorageKey);
      }
    }
  } catch {
    // Safari private browsing may deny localStorage.
  }
  if (storedSecret) return storedSecret;
  try {
    const cookie = document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(`${pendingPairingCookieName}=`));
    const value = cookie ? decodeURIComponent(cookie.slice(pendingPairingCookieName.length + 1)) : "";
    return validPairingSecret(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function rememberPairingCookie(secret: string) {
  try {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    // This is a fallback bridge for iOS versions that copy first-party
    // cookies when creating a Home Screen Web App. The invitation launch URL
    // is the primary handoff because Safari and standalone storage are isolated.
    document.cookie = `${pendingPairingCookieName}=${encodeURIComponent(secret)}; Max-Age=${Math.floor(pendingPairingMaxAgeMs / 1000)}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // Safari private browsing may deny cookies; the URL/manual reconnect is the fallback.
  }
}

function clearPendingPairingCookie() {
  try {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${pendingPairingCookieName}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
  } catch {
    // Ignore cookie cleanup failures.
  }
}

export function rememberPairingSecretForInstall(secret: string) {
  if (!validPairingSecret(secret)) return;
  try {
    localStorage.setItem(pendingPairingStorageKey, JSON.stringify({ secret, savedAt: Date.now() }));
  } catch {
    // Safari private browsing may deny localStorage; use the cookie/URL fallback.
  }
  rememberPairingCookie(secret);
}

export function clearPendingPairingSecret() {
  try {
    localStorage.removeItem(pendingPairingStorageKey);
  } catch {
    // Ignore storage cleanup failures.
  }
  clearPendingPairingCookie();
}

export function pairingSecretFromText(input: string) {
  const text = input.trim();
  if (validPairingSecret(text)) return text;
  try {
    const url = new URL(text, location.href);
    const value = new URLSearchParams(url.hash.replace(/^#/, "")).get("pair") ?? url.searchParams.get("pair");
    return validPairingSecret(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function shouldKeepPairingSecretForInstall() {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return !standalone;
}

export function clearPairingSecretFromLocation() {
  const url = new URL(location.href);
  const hadHashPair = url.hash.includes("pair=");
  const hadSearchPair = url.searchParams.has("pair");
  if (!hadHashPair && !hadSearchPair) return;
  url.searchParams.delete("pair");
  url.hash = "";
  history.replaceState(null, "", `${url.pathname}${url.search}`);
}

export function createInviteUrl(secret: string) {
  const url = new URL(location.href);
  url.search = new URLSearchParams({ pair: secret }).toString();
  url.hash = "";
  return url.toString();
}
