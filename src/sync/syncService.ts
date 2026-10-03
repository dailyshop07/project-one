import type { DeviceRecord, SyncOperation } from "../types";
import type { Repository } from "../db/repository";
import { randomId, roomIdFromSecret, validPairingSecret } from "../db/identity";
import { CloudflareSyncAdapter, configuredCloudflareSyncEndpoint, type CloudflareSyncEvent, type SyncPeer } from "./cloudflareSyncAdapter";

export type SyncStatus = "local" | "offline" | "connecting" | "connected" | "syncing" | "pending" | "error";

const pendingPairingStorageKey = "project-one-pending-pairing-v1";
const pendingPairingCookieName = "project_one_pending_pairing_v1";
const pendingPairingMaxAgeMs = 24 * 60 * 60 * 1000;
const snapshotBatchSize = 50;
const pendingConnectionNoticeMs = 3_000;
const foregroundEventDebounceMs = 1_000;
const snapshotTimeoutMs = 15_000;
const blockedPeerSettingKey = "sync.blocked-peer-ids.v1";
const disconnectedPeerSettingKey = "sync.disconnected-peer-ids.v1";
const reconnectInitialDelayMs = 1_000;
const reconnectMaxDelayMs = 30_000;

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

export class SyncService {
  private adapter?: CloudflareSyncAdapter;
  private adapterCleanup?: () => void;
  private currentPeers = new Set<string>();
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
  private announcing = new Set<string>();
  private snapshotting = new Set<string>();
  private snapshotSynced = new Set<string>();
  private snapshotWaiters = new Map<string, { resolve: (complete: boolean) => void; timer: number }>();
  private incomingSnapshots = new Map<string, { batchCount: number; received: Set<number> }>();
  private device?: DeviceRecord;
  private secret?: string;
  private pendingTimer?: number;
  private deliveryTimer?: number;
  private reconnectTimer?: number;
  private reconnectDelayMs = reconnectInitialDelayMs;
  private reconnectPromise?: Promise<void>;
  private recoveryPromise?: Promise<void>;
  private stopped = false;

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
    console.info(`[Cloudflare Sync] ${message}`, ...details);
  }

  private isCurrent(generation: number, adapter = this.adapter) {
    return generation === this.connectionGeneration && adapter === this.adapter && !this.stopped;
  }

  private peerStatuses(): Record<string, PeerStatus> {
    const statuses: Record<string, PeerStatus> = {};
    for (const deviceId of this.peerDevices.keys()) statuses[deviceId] = this.currentPeers.has(deviceId) ? "connected" : "known";
    for (const deviceId of this.currentPeers) statuses[deviceId] ??= "connected";
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

  private shouldRejectPeer(deviceId: string) {
    return this.blockedPeerIds.has(deviceId) || this.disconnectedPeerIds.has(deviceId);
  }

  private clearConnectionTimers() {
    if (this.pendingTimer !== undefined) window.clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private delay(milliseconds: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
  }

  private clearDeliveryTimer() {
    if (this.deliveryTimer !== undefined) window.clearInterval(this.deliveryTimer);
    this.deliveryTimer = undefined;
  }

  private startDeliveryWatch() {
    if (this.deliveryTimer !== undefined) return;
    this.deliveryTimer = window.setInterval(() => void this.retryDelivery(), 2_500);
  }

  private schedulePendingNotice() {
    if (this.pendingTimer !== undefined || this.stopped || !navigator.onLine || !this.adapter?.isOpen) return;
    this.pendingTimer = window.setTimeout(() => {
      this.pendingTimer = undefined;
      if (this.adapter?.isOpen && !this.currentPeers.size) this.setState({ status: "pending", peerCount: 0 });
    }, pendingConnectionNoticeMs);
  }

  private scheduleReconnect(delayMs = this.reconnectDelayMs) {
    if (this.reconnectTimer !== undefined || this.stopped || !navigator.onLine || document.visibilityState === "hidden") return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.runReconnectFlow("automatic retry");
    }, delayMs);
    this.reconnectDelayMs = Math.min(reconnectMaxDelayMs, Math.max(reconnectInitialDelayMs, this.reconnectDelayMs * 2));
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

  private clearSnapshotState() {
    for (const waiter of this.snapshotWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.snapshotWaiters.clear();
    this.incomingSnapshots.clear();
  }

  private clearPeerState() {
    this.currentPeers.clear();
    this.peerDevices.clear();
    this.flushing.clear();
    this.announcing.clear();
    this.snapshotting.clear();
    this.snapshotSynced.clear();
    this.clearSnapshotState();
  }

  private async destroyCurrentConnection() {
    this.connectionGeneration += 1;
    this.clearConnectionTimers();
    this.clearReconnectTimer();
    this.clearSnapshotState();
    const adapter = this.adapter;
    this.adapter = undefined;
    this.adapterCleanup?.();
    this.adapterCleanup = undefined;
    adapter?.close(1000, "reconnecting");
    this.clearPeerState();
    this.setState({ status: navigator.onLine ? "connecting" : "offline", peerCount: 0, peerStatuses: this.peerStatuses() });
  }

  private async handleAdapterEvent(event: CloudflareSyncEvent, generation: number, adapter: CloudflareSyncAdapter) {
    if (!this.isCurrent(generation, adapter)) return;
    if (event.type === "open") {
      this.reconnectDelayMs = reconnectInitialDelayMs;
      this.clearConnectionTimers();
      this.currentPeers = new Set(event.peers.map((peer) => peer.deviceId).filter((deviceId) => deviceId !== this.device?.deviceId));
      this.peerDevices = new Map(event.peers.map((peer) => [peer.deviceId, peer.label]));
      this.setState({ status: this.currentPeers.size ? "connected" : "connecting", peerCount: this.currentPeers.size, peerStatuses: this.peerStatuses() });
      this.startDeliveryWatch();
      if (!this.currentPeers.size) this.schedulePendingNotice();
      for (const peer of event.peers) void this.announcePeer(peer.deviceId, generation);
      return;
    }
    if (event.type === "peerJoined") {
      if (event.peer.deviceId === this.device?.deviceId) return;
      this.peerDevices.set(event.peer.deviceId, event.peer.label);
      this.currentPeers.add(event.peer.deviceId);
      this.clearConnectionTimers();
      if (!this.shouldRejectPeer(event.peer.deviceId)) {
        await this.repository.rememberPeer(event.peer.deviceId, event.peer.label);
        this.setState({ status: "connected", peerCount: this.currentPeers.size, peerStatuses: this.peerStatuses() });
        void this.announcePeer(event.peer.deviceId, generation);
      } else {
        this.publishPeerStatuses();
      }
      return;
    }
    if (event.type === "peerLeft") {
      this.currentPeers.delete(event.deviceId);
      this.peerDevices.delete(event.deviceId);
      this.snapshotSynced.delete(event.deviceId);
      this.announcing.delete(`${generation}:${event.deviceId}`);
      for (const key of this.incomingSnapshots.keys()) if (key.startsWith(`${event.deviceId}:`)) this.incomingSnapshots.delete(key);
      if (!this.currentPeers.size) {
        this.setState({ status: this.adapter?.isOpen ? "pending" : navigator.onLine ? "connecting" : "offline", peerCount: 0, peerStatuses: this.peerStatuses() });
        this.schedulePendingNotice();
      } else {
        this.setState({ status: "connected", peerCount: this.currentPeers.size, peerStatuses: this.peerStatuses() });
      }
      return;
    }
    if (event.type === "close") {
      this.clearConnectionTimers();
      this.clearPeerState();
      this.setState({ status: navigator.onLine ? "connecting" : "offline", peerCount: 0, peerStatuses: this.peerStatuses() });
      this.scheduleReconnect();
      return;
    }
    if (event.type === "error") {
      if (!this.currentPeers.size) this.setState({ status: navigator.onLine ? "error" : "offline" });
      return;
    }
    await this.handleIncomingMessage(event.from, event.message, generation, adapter);
  }

  private async connectFresh() {
    const secret = this.secret;
    const device = this.device;
    const endpoint = configuredCloudflareSyncEndpoint();
    if (this.stopped || !navigator.onLine || !secret || !device || !endpoint) {
      if (!endpoint) this.setState({ status: navigator.onLine ? "local" : "offline" });
      return false;
    }
    const generation = ++this.connectionGeneration;
    const roomId = await roomIdFromSecret(secret);
    if (this.stopped || !navigator.onLine || this.secret !== secret || this.device?.deviceId !== device.deviceId) return false;
    const adapter = new CloudflareSyncAdapter(endpoint);
    this.adapter = adapter;
    this.adapterCleanup = adapter.subscribe((event) => void this.handleAdapterEvent(event, generation, adapter));
    this.setState({ status: "connecting", peerCount: 0, peerStatuses: this.peerStatuses() });
    try {
      await adapter.connect({ roomId, secret, device });
      if (!this.isCurrent(generation, adapter)) return false;
      return true;
    } catch (error) {
      if (this.isCurrent(generation, adapter)) {
        this.log("connection failed", error);
        this.adapterCleanup?.();
        this.adapterCleanup = undefined;
        this.adapter = undefined;
        adapter.close(1000, "connection failed");
        this.clearPeerState();
        this.setState({ status: navigator.onLine ? "error" : "offline", peerCount: 0, peerStatuses: this.peerStatuses() });
      }
      return false;
    }
  }

  private async runReconnectFlow(reason: string) {
    if (this.reconnectPromise) return this.reconnectPromise;
    if (this.stopped || !navigator.onLine || !this.secret || !this.device) return;
    const flow = (async () => {
      this.log(`reconnecting: ${reason}`);
      await this.destroyCurrentConnection();
      if (this.stopped || !navigator.onLine) return;
      if (await this.connectFresh()) return;
      this.scheduleReconnect();
    })();
    this.reconnectPromise = flow;
    void flow.finally(() => {
      if (this.reconnectPromise === flow) this.reconnectPromise = undefined;
    });
    return flow;
  }

  private async announcePeer(peerId: string, generation: number) {
    const key = `${generation}:${peerId}`;
    if (!this.isCurrent(generation) || this.announcing.has(key) || this.shouldRejectPeer(peerId)) return;
    this.announcing.add(key);
    try {
      await this.send({ protocol: 1, deviceId: this.device!.deviceId, label: this.device!.label } as HelloMessage, peerId);
      await this.send({ protocol: 1, type: "requestSnapshot", senderDeviceId: this.device!.deviceId, requestId: randomId() } as SyncControlMessage, peerId);
      await this.sendSnapshotToPeer(peerId, true, generation);
      await this.flushToPeer(peerId, generation);
    } catch {
      if (this.isCurrent(generation)) this.setState({ status: navigator.onLine ? "pending" : "offline" });
    } finally {
      this.announcing.delete(key);
    }
  }

  private async send(message: unknown, targetDeviceId?: string) {
    if (!this.adapter?.isOpen) throw new Error("同步连接尚未打开");
    await this.adapter.send(message, targetDeviceId);
  }

  private async sendSnapshotToPeer(peerId: string, force = false, generation = this.connectionGeneration) {
    const snapshottingKey = `${generation}:${peerId}`;
    if (!this.device || !this.adapter?.isOpen || !this.isCurrent(generation) || this.shouldRejectPeer(peerId) || this.snapshotting.has(snapshottingKey) || (!force && this.snapshotSynced.has(peerId))) return;
    this.snapshotting.add(snapshottingKey);
    this.setState({ status: "syncing" });
    const snapshotId = randomId();
    const waiterKey = this.snapshotWaiterKey(peerId, snapshotId);
    const completion = new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        this.snapshotWaiters.delete(waiterKey);
        resolve(false);
      }, snapshotTimeoutMs);
      this.snapshotWaiters.set(waiterKey, { resolve, timer });
    });
    try {
      const operations = await this.repository.snapshotOperations();
      const batches = operations.length
        ? Array.from({ length: Math.ceil(operations.length / snapshotBatchSize) }, (_, index) => operations.slice(index * snapshotBatchSize, (index + 1) * snapshotBatchSize))
        : [[]];
      for (const [batchIndex, batch] of batches.entries()) {
        if (!this.isCurrent(generation) || !this.currentPeers.has(peerId)) {
          this.resolveSnapshot(peerId, snapshotId, false);
          return;
        }
        await this.send({
          protocol: 1,
          senderDeviceId: this.device.deviceId,
          operations: batch,
          snapshot: true,
          snapshotId,
          batchIndex,
          batchCount: batches.length,
        } as OperationsMessage, peerId);
      }
      if (await completion && this.isCurrent(generation)) {
        this.snapshotSynced.add(peerId);
        this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
      } else if (this.isCurrent(generation)) {
        this.setState({ status: navigator.onLine ? "pending" : "offline" });
      }
    } catch {
      this.resolveSnapshot(peerId, snapshotId, false);
      if (this.isCurrent(generation)) this.setState({ status: navigator.onLine ? "pending" : "offline" });
    } finally {
      this.snapshotting.delete(snapshottingKey);
    }
  }

  private async flushToPeer(peerId: string, generation = this.connectionGeneration) {
    const flushingKey = `${generation}:${peerId}`;
    if (!this.device || !this.adapter?.isOpen || !this.isCurrent(generation) || this.shouldRejectPeer(peerId) || this.flushing.has(flushingKey)) return;
    this.flushing.add(flushingKey);
    try {
      while (true) {
        const pending = await this.repository.pendingOperations(50);
        if (!this.isCurrent(generation) || !pending.length) return;
        const ids = pending.map((operation) => operation.operationId);
        await this.repository.markSending(ids);
        this.setState({ status: "syncing" });
        try {
          await this.send({ protocol: 1, senderDeviceId: this.device.deviceId, operations: pending } as OperationsMessage, peerId);
        } catch {
          await this.repository.requeueOperations(ids);
          if (this.isCurrent(generation)) this.setState({ status: navigator.onLine ? "pending" : "offline" });
          return;
        }
      }
    } finally {
      this.flushing.delete(flushingKey);
    }
  }

  private async retryDelivery() {
    if (!this.adapter?.isOpen || !this.currentPeers.size) return;
    await this.repository.requeueStaleSending(4_000);
    const generation = this.connectionGeneration;
    await Promise.all(Array.from(this.currentPeers).map(async (peerId) => {
      await this.sendSnapshotToPeer(peerId, false, generation);
      await this.flushToPeer(peerId, generation);
    }));
  }

  private async requestFreshSnapshots(generation = this.connectionGeneration) {
    if (!this.adapter?.isOpen || !this.device || !this.currentPeers.size) return;
    await Promise.allSettled(Array.from(this.currentPeers).filter((peerId) => !this.shouldRejectPeer(peerId)).map((peerId) => this.send({
      protocol: 1,
      type: "requestSnapshot",
      senderDeviceId: this.device!.deviceId,
      requestId: randomId(),
    } as SyncControlMessage, peerId)));
    if (this.isCurrent(generation)) this.setState({ status: "connected" });
  }

  private async handleIncomingMessage(from: SyncPeer, value: unknown, generation: number, adapter: CloudflareSyncAdapter) {
    if (!this.isCurrent(generation, adapter) || from.deviceId === this.device?.deviceId || this.shouldRejectPeer(from.deviceId)) return;
    if (isHello(value)) {
      if (value.deviceId !== from.deviceId) return;
      this.peerDevices.set(from.deviceId, value.label);
      await this.repository.rememberPeer(from.deviceId, value.label);
      await this.sendSnapshotToPeer(from.deviceId, false, generation);
      await this.flushToPeer(from.deviceId, generation);
      this.publishPeerStatuses();
      return;
    }
    if (isSyncControl(value)) {
      if (value.senderDeviceId !== from.deviceId) return;
      if (value.type === "snapshotComplete") {
        this.resolveSnapshot(from.deviceId, value.snapshotId, true);
        return;
      }
      await this.sendSnapshotToPeer(from.deviceId, true, generation);
      await this.flushToPeer(from.deviceId, generation);
      return;
    }
    if (isOperations(value)) {
      if (value.senderDeviceId !== from.deviceId) return;
      try {
        this.setState({ status: "syncing" });
        const operationIds = await this.repository.applyRemoteOperations(value.operations);
        if (!this.isCurrent(generation, adapter)) return;
        await this.send({ protocol: 1, senderDeviceId: this.device!.deviceId, operationIds } as AckMessage, from.deviceId);
        const { snapshotId, batchIndex, batchCount } = value;
        if (value.snapshot && typeof snapshotId === "string" && typeof batchIndex === "number" && Number.isInteger(batchIndex) && typeof batchCount === "number" && Number.isInteger(batchCount) && batchCount > 0) {
          const snapshotKey = this.snapshotWaiterKey(from.deviceId, snapshotId);
          const progress = this.incomingSnapshots.get(snapshotKey) ?? { batchCount, received: new Set<number>() };
          progress.received.add(batchIndex);
          this.incomingSnapshots.set(snapshotKey, progress);
          if (progress.received.size >= progress.batchCount) {
            this.incomingSnapshots.delete(snapshotKey);
            await this.send({ protocol: 1, type: "snapshotComplete", senderDeviceId: this.device!.deviceId, snapshotId, batchCount: progress.batchCount } as SyncControlMessage, from.deviceId);
          }
        }
        await this.repository.markPeerSynced(from.deviceId);
        if (this.isCurrent(generation, adapter)) this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
      } catch {
        if (this.isCurrent(generation, adapter)) this.setState({ status: navigator.onLine ? "pending" : "offline" });
      }
      return;
    }
    if (isAck(value)) {
      if (value.senderDeviceId !== from.deviceId) return;
      await this.repository.acknowledgeOperations(value.operationIds);
      await this.repository.markPeerSynced(from.deviceId);
      if (!this.isCurrent(generation, adapter)) return;
      this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
      await this.flushToPeer(from.deviceId, generation);
    }
  }

  async start(secret: string, device: DeviceRecord) {
    if (!validPairingSecret(secret)) return;
    if (this.adapter?.isOpen || this.reconnectPromise) return this.reconnectPromise;
    this.stopped = false;
    this.secret = secret;
    this.device = device;
    await this.loadPeerControlState();
    if (!navigator.onLine) {
      this.setState({ status: "offline", peerStatuses: this.peerStatuses() });
      return;
    }
    if (!configuredCloudflareSyncEndpoint()) {
      this.setState({ status: "local", peerStatuses: this.peerStatuses() });
      return;
    }
    await this.runReconnectFlow("startup");
  }

  async notifyLocalChange() {
    if (!this.adapter?.isOpen || !this.device) {
      this.setState({ status: navigator.onLine ? configuredCloudflareSyncEndpoint() ? "pending" : "local" : "offline" });
      return;
    }
    const generation = this.connectionGeneration;
    await Promise.all(Array.from(this.currentPeers).map((peerId) => this.flushToPeer(peerId, generation)));
  }

  async updateDeviceLabel(label: string) {
    if (!this.device || !this.adapter?.isOpen) return;
    this.device = { ...this.device, label };
    await this.send({ protocol: 1, deviceId: this.device.deviceId, label } as HelloMessage);
  }

  async disconnectPeer(deviceId: string) {
    if (!deviceId || deviceId === this.device?.deviceId) return;
    await this.loadPeerControlState();
    this.disconnectedPeerIds.add(deviceId);
    this.blockedPeerIds.delete(deviceId);
    await this.savePeerControlState();
    this.publishPeerStatuses();
  }

  async reconnectPeer(deviceId: string) {
    if (!deviceId || deviceId === this.device?.deviceId) return;
    await this.loadPeerControlState();
    this.disconnectedPeerIds.delete(deviceId);
    await this.savePeerControlState();
    this.publishPeerStatuses();
    if (navigator.onLine && this.adapter?.isOpen && this.currentPeers.has(deviceId)) {
      await this.announcePeer(deviceId, this.connectionGeneration);
    } else if (navigator.onLine) {
      await this.handleOnline(true);
    }
  }

  async unlinkPeer(deviceId: string) {
    if (!deviceId || deviceId === this.device?.deviceId) return;
    await this.loadPeerControlState();
    this.blockedPeerIds.add(deviceId);
    this.disconnectedPeerIds.delete(deviceId);
    await this.savePeerControlState();
    this.publishPeerStatuses();
  }

  async allowPeer(deviceId: string) {
    if (!deviceId || deviceId === this.device?.deviceId) return;
    await this.loadPeerControlState();
    this.blockedPeerIds.delete(deviceId);
    this.disconnectedPeerIds.delete(deviceId);
    await this.savePeerControlState();
    this.publishPeerStatuses();
    if (navigator.onLine && this.adapter?.isOpen && this.currentPeers.has(deviceId)) await this.announcePeer(deviceId, this.connectionGeneration);
    else if (navigator.onLine) await this.handleOnline(true);
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

  private async checkExistingConnection() {
    if (!this.adapter?.isOpen) return false;
    const healthy = await this.adapter.healthCheck();
    if (!healthy) return false;
    this.setState({ status: this.currentPeers.size ? "connected" : "pending", peerCount: this.currentPeers.size });
    if (this.currentPeers.size) await this.requestFreshSnapshots();
    return true;
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
      if (!forceFresh && await this.checkExistingConnection()) return;
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
    if (!configuredCloudflareSyncEndpoint()) return;
    await this.recoverConnection(forceReconnect ? "manual reconnect" : "network online", forceReconnect);
  }

  handleHidden() {
    if (this.lastBackgroundAt === undefined) this.lastBackgroundAt = Date.now();
    this.lastForegroundAt = 0;
    this.clearReconnectTimer();
  }

  handleOffline() {
    this.clearConnectionTimers();
    this.clearReconnectTimer();
    this.connectionGeneration += 1;
    this.adapter?.close(1001, "offline");
    this.clearPeerState();
    this.setState({ status: "offline", peerCount: 0, peerStatuses: this.peerStatuses() });
  }

  stop() {
    this.stopped = true;
    this.clearConnectionTimers();
    this.clearReconnectTimer();
    this.clearDeliveryTimer();
    this.connectionGeneration += 1;
    const adapter = this.adapter;
    this.adapter = undefined;
    this.adapterCleanup?.();
    this.adapterCleanup = undefined;
    adapter?.close(1000, "stopped");
    this.clearPeerState();
    this.lastBackgroundAt = undefined;
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
      if (validPairingSecret(value.secret ?? null) && value.savedAt && Date.now() - value.savedAt <= pendingPairingMaxAgeMs) storedSecret = value.secret;
      else localStorage.removeItem(pendingPairingStorageKey);
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
    document.cookie = `${pendingPairingCookieName}=${encodeURIComponent(secret)}; Max-Age=${Math.floor(pendingPairingMaxAgeMs / 1000)}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // Safari private browsing may deny cookies; use the URL/manual reconnect fallback.
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
