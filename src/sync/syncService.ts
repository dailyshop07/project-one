import type { DeviceRecord, StoredSyncEvent, SyncOperation } from "../types";
import type { Repository } from "../db/repository";
import { randomId, roomIdFromSecret, validPairingSecret } from "../db/identity";
import {
  CloudflareSyncAdapter,
  configuredCloudflareSyncEndpoint,
  type CloudflareSyncEvent,
  type SyncPeer,
} from "./cloudflareSyncAdapter";
import { createSyncCipher, splitCiphertext, type SyncCipher } from "./syncCrypto";

export type SyncStatus = "local" | "offline" | "connecting" | "connected" | "syncing" | "pending" | "error";

const pendingPairingStorageKey = "project-one-pending-pairing-v1";
const pendingPairingCookieName = "project_one_pending_pairing_v1";
const pendingPairingMaxAgeMs = 24 * 60 * 60 * 1000;
const blockedPeerSettingKey = "sync.blocked-peer-ids.v1";
const disconnectedPeerSettingKey = "sync.disconnected-peer-ids.v1";
const snapshotSeededSettingKey = "sync.snapshot-seeded.v2";
const reconnectInitialDelayMs = 1_000;
const reconnectMaxDelayMs = 30_000;
const foregroundEventDebounceMs = 1_000;
const uploadBatchSize = 50;

export interface SyncViewState {
  status: SyncStatus;
  peerCount: number;
  lastSyncedAt?: string;
  peerStatuses: Record<string, PeerStatus>;
}

export type PeerStatus = "connected" | "disconnected" | "unlinked" | "known";

type IncomingCheckpoint = {
  baseSequence: number;
  chunkCount: number;
  parts: Map<number, string>;
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
  private device?: DeviceRecord;
  private secret?: string;
  private cipher?: SyncCipher;
  private lastAppliedSequence = 0;
  private latestServerSequence = 0;
  private snapshotSeeded = false;
  private checkpointUploads = new Map<string, IncomingCheckpoint>();
  private eventQueue: Promise<void> = Promise.resolve();
  private flushPromise?: Promise<void>;
  private snapshotSeedPromise?: Promise<void>;
  private checkpointUploadPromise?: Promise<void>;
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

  private clearReconnectTimer() {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private scheduleReconnect(delayMs = this.reconnectDelayMs) {
    if (this.reconnectTimer !== undefined || this.stopped || !navigator.onLine || document.visibilityState === "hidden") return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.runReconnectFlow("automatic retry");
    }, delayMs);
    this.reconnectDelayMs = Math.min(reconnectMaxDelayMs, Math.max(reconnectInitialDelayMs, this.reconnectDelayMs * 2));
  }

  private clearDeliveryTimer() {
    if (this.deliveryTimer !== undefined) window.clearInterval(this.deliveryTimer);
    this.deliveryTimer = undefined;
  }

  private startDeliveryWatch() {
    if (this.deliveryTimer !== undefined) return;
    this.deliveryTimer = window.setInterval(() => void this.retryDelivery(), 2_500);
  }

  private clearPeerState() {
    this.currentPeers.clear();
    this.peerDevices.clear();
    this.checkpointUploads.clear();
    this.setState({ peerCount: 0, peerStatuses: this.peerStatuses() });
  }

  private async destroyCurrentConnection() {
    this.connectionGeneration += 1;
    this.clearReconnectTimer();
    const adapter = this.adapter;
    this.adapter = undefined;
    this.adapterCleanup?.();
    this.adapterCleanup = undefined;
    adapter?.close(1000, "reconnecting");
    this.clearPeerState();
    this.setState({ status: navigator.onLine ? "connecting" : "offline", peerCount: 0, peerStatuses: this.peerStatuses() });
  }

  private enqueue(task: () => Promise<void>) {
    const next = this.eventQueue.then(task, task);
    this.eventQueue = next.catch(() => undefined);
    return next;
  }

  private async handleAdapterEvent(event: CloudflareSyncEvent, generation: number, adapter: CloudflareSyncAdapter) {
    if (!this.isCurrent(generation, adapter)) return;
    if (event.type === "catchup") {
      await this.enqueue(async () => {
        const result = await this.applyStoredEvents(event.events);
        if (!this.isCurrent(generation, adapter)) return;
        if (result.gap) {
          adapter.requestCatchup(result.lastAppliedSequence);
          return;
        }
        adapter.ackCatchup(result.lastAppliedSequence);
      });
      return;
    }
    if (event.type === "checkpointStart") {
      this.checkpointUploads.set(event.checkpointId, { baseSequence: event.baseSequence, chunkCount: event.chunkCount, parts: new Map() });
      return;
    }
    if (event.type === "checkpointChunk") {
      const checkpoint = this.checkpointUploads.get(event.checkpointId);
      if (checkpoint && event.chunkIndex >= 0 && event.chunkIndex < checkpoint.chunkCount) checkpoint.parts.set(event.chunkIndex, event.data);
      return;
    }
    if (event.type === "checkpointComplete") {
      await this.enqueue(async () => {
        const checkpoint = this.checkpointUploads.get(event.checkpointId);
        this.checkpointUploads.delete(event.checkpointId);
        if (!checkpoint || checkpoint.parts.size !== checkpoint.chunkCount || checkpoint.baseSequence !== event.baseSequence || !this.cipher) {
          adapter.requestCatchup(this.lastAppliedSequence);
          return;
        }
        try {
          const payload = Array.from({ length: checkpoint.chunkCount }, (_, index) => checkpoint.parts.get(index) ?? "").join("");
          const decoded = await this.cipher.decryptCheckpoint(payload);
          if (decoded.baseSequence !== event.baseSequence) throw new Error("checkpoint sequence mismatch");
          await this.repository.applyCheckpoint(decoded.operations, decoded.baseSequence);
          this.lastAppliedSequence = await this.repository.getLastAppliedSequence();
          adapter.ackCheckpoint(event.checkpointId, event.baseSequence);
        } catch (error) {
          this.log("checkpoint apply failed", error);
          adapter.requestCatchup(this.lastAppliedSequence);
        }
      });
      return;
    }
    if (event.type === "events") {
      await this.enqueue(async () => {
        const result = await this.applyStoredEvents(event.events);
        if (result.gap && this.isCurrent(generation, adapter)) adapter.requestCatchup(result.lastAppliedSequence);
        if (!result.gap && this.isCurrent(generation, adapter)) {
          await this.repository.markPeerSynced(event.from.deviceId);
          this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
        }
      });
      return;
    }
    if (event.type === "publishAck") {
      this.latestServerSequence = Math.max(this.latestServerSequence, event.latestSequence);
      return;
    }
    if (event.type === "catchupComplete") {
      this.latestServerSequence = Math.max(this.latestServerSequence, event.latestSequence);
      return;
    }
    if (event.type === "open") {
      this.reconnectDelayMs = reconnectInitialDelayMs;
      this.latestServerSequence = Math.max(this.latestServerSequence, event.latestSequence);
      this.currentPeers = new Set(event.peers.map((peer) => peer.deviceId).filter((deviceId) => deviceId !== this.device?.deviceId));
      this.peerDevices = new Map(event.peers.map((peer) => [peer.deviceId, peer.label]));
      for (const peer of event.peers) void this.repository.rememberPeer(peer.deviceId, peer.label);
      this.setState({ status: "connected", peerCount: this.currentPeers.size, peerStatuses: this.peerStatuses() });
      this.startDeliveryWatch();
      void this.synchronizeOnOpen(event.needsSnapshot, generation, adapter);
      return;
    }
    if (event.type === "peerJoined") {
      if (event.peer.deviceId === this.device?.deviceId) return;
      this.peerDevices.set(event.peer.deviceId, event.peer.label);
      this.currentPeers.add(event.peer.deviceId);
      await this.repository.rememberPeer(event.peer.deviceId, event.peer.label);
      this.setState({ status: "connected", peerCount: this.currentPeers.size, peerStatuses: this.peerStatuses() });
      return;
    }
    if (event.type === "peerLeft") {
      this.currentPeers.delete(event.deviceId);
      this.peerDevices.delete(event.deviceId);
      this.setState({ status: this.adapter?.isOpen ? "connected" : navigator.onLine ? "connecting" : "offline", peerCount: this.currentPeers.size, peerStatuses: this.peerStatuses() });
      return;
    }
    if (event.type === "checkpointRequest") {
      await this.uploadCheckpoint(event.targetSequence, generation, adapter);
      return;
    }
    if (event.type === "close") {
      this.clearPeerState();
      this.setState({ status: navigator.onLine ? "connecting" : "offline", peerCount: 0, peerStatuses: this.peerStatuses() });
      this.scheduleReconnect();
      return;
    }
    if (event.type === "error") {
      this.setState({ status: navigator.onLine ? "error" : "offline" });
    }
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
      await adapter.connect({ roomId, secret, device, lastAppliedSequence: this.lastAppliedSequence });
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

  private async applyStoredEvents(events: StoredSyncEvent[]) {
    if (!this.cipher) return { lastAppliedSequence: this.lastAppliedSequence, gap: false };
    const operations = [] as Array<{ sequence: number; eventId: string; operation: SyncOperation }>;
    for (const event of events.slice().sort((left, right) => left.sequence - right.sequence)) {
      if (event.sequence <= this.lastAppliedSequence) continue;
      const operation = await this.cipher.decryptOperation(event.eventId, event.encrypted, event.payload);
      // The outer sender is the device that uploaded the event. The payload's
      // deviceId is the original business-record author and may legitimately
      // belong to another device when a device seeds a migrated snapshot.
      if (!operation || typeof operation.deviceId !== "string" || !operation.deviceId) throw new Error("同步事件来源不一致");
      operations.push({ sequence: event.sequence, eventId: event.eventId, operation: { ...operation, eventId: event.eventId } });
    }
    const result = await this.repository.applyRemoteEvents(operations);
    this.lastAppliedSequence = result.lastAppliedSequence;
    return result;
  }

  private async seedServerSnapshot() {
    if (this.snapshotSeeded || !this.adapter?.isReady || !this.device || !this.cipher) return;
    if (this.snapshotSeedPromise) return this.snapshotSeedPromise;
    const flow = (async () => {
      const operations = await this.repository.snapshotOperations();
      for (let index = 0; index < operations.length; index += uploadBatchSize) {
        if (!this.adapter?.isReady || !this.device || !this.cipher) throw new Error("同步连接已关闭");
        const batch = operations.slice(index, index + uploadBatchSize).map((operation) => ({
          eventId: `${this.device!.deviceId}:seed:${operation.eventId ?? operation.operationId}`,
          senderDeviceId: this.device!.deviceId,
          createdAt: operation.createdAt,
          encrypted: false,
          payload: "",
          operation,
        }));
        const encrypted = await Promise.all(batch.map(async (entry) => {
          const result = await this.cipher!.encryptOperation(entry.eventId, entry.operation);
          return { ...entry, encrypted: result.encrypted, payload: result.payload };
        }));
        const accepted = await this.adapter.publish(encrypted.map(({ eventId, senderDeviceId, createdAt, encrypted: isEncrypted, payload }) => ({ eventId, senderDeviceId, createdAt, encrypted: isEncrypted, payload })));
        if (accepted.length !== encrypted.length) throw new Error("服务器未确认全部初始同步事件");
      }
      await this.repository.setSetting(snapshotSeededSettingKey, true);
      this.snapshotSeeded = true;
    })();
    this.snapshotSeedPromise = flow;
    void flow.finally(() => {
      if (this.snapshotSeedPromise === flow) this.snapshotSeedPromise = undefined;
    });
    return flow;
  }

  private async flushToServer() {
    if (this.flushPromise) return this.flushPromise;
    const flow = (async () => {
      if (this.snapshotSeedPromise) await this.snapshotSeedPromise;
      if (!this.device || !this.cipher || !this.adapter?.isReady) return;
      await this.repository.requeueStaleSending(4_000);
      while (this.adapter?.isReady && this.device && this.cipher && !this.stopped) {
        const pending = await this.repository.pendingOperations(uploadBatchSize);
        if (!pending.length) break;
        const operationIds = pending.map((operation) => operation.operationId);
        await this.repository.markSending(operationIds);
        try {
          const events = await Promise.all(pending.map(async (operation) => {
            const eventId = operation.eventId ?? operation.operationId;
            const result = await this.cipher!.encryptOperation(eventId, operation);
            return { eventId, senderDeviceId: this.device!.deviceId, createdAt: operation.createdAt, encrypted: result.encrypted, payload: result.payload, operationId: operation.operationId };
          }));
          const accepted = await this.adapter.publish(events.map(({ eventId, senderDeviceId, createdAt, encrypted, payload }) => ({ eventId, senderDeviceId, createdAt, encrypted, payload })));
          const acceptedEventIds = new Set(accepted.map((entry) => entry.eventId));
          const acknowledged = events.filter((entry) => acceptedEventIds.has(entry.eventId)).map((entry) => entry.operationId);
          const missing = events.filter((entry) => !acceptedEventIds.has(entry.eventId)).map((entry) => entry.operationId);
          await this.repository.acknowledgeOperations(acknowledged);
          await this.repository.requeueOperations(missing);
          this.latestServerSequence = Math.max(this.latestServerSequence, ...accepted.map((entry) => entry.sequence), 0);
          if (missing.length) {
            this.setState({ status: "pending" });
            return;
          }
        } catch (error) {
          await this.repository.requeueOperations(operationIds);
          this.log("event upload failed", error);
          this.setState({ status: navigator.onLine ? "pending" : "offline" });
          return;
        }
      }
      if (this.adapter?.isReady && this.latestServerSequence > this.lastAppliedSequence) {
        this.setState({ status: "syncing" });
        this.adapter.requestCatchup(this.lastAppliedSequence);
      } else if (this.adapter?.isReady) {
        this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
      }
    })();
    this.flushPromise = flow;
    void flow.finally(() => {
      if (this.flushPromise === flow) this.flushPromise = undefined;
    });
    return flow;
  }

  private async synchronizeOnOpen(needsSnapshot: boolean, generation: number, adapter: CloudflareSyncAdapter) {
    if (!this.isCurrent(generation, adapter)) return;
    try {
      if (needsSnapshot || !this.snapshotSeeded) await this.seedServerSnapshot();
      if (!this.isCurrent(generation, adapter)) return;
      await this.flushToServer();
    } catch (error) {
      this.log("initial synchronization failed", error);
      if (this.isCurrent(generation, adapter)) this.setState({ status: navigator.onLine ? "pending" : "offline" });
    }
  }

  private async retryDelivery() {
    if (!this.adapter?.isReady) return;
    await this.flushToServer();
  }

  private async uploadCheckpoint(targetSequence: number, generation: number, adapter: CloudflareSyncAdapter) {
    if (this.checkpointUploadPromise) return this.checkpointUploadPromise;
    const flow = (async () => {
      if (!this.isCurrent(generation, adapter) || !this.cipher || !this.device || !adapter.isReady || this.lastAppliedSequence < targetSequence) return;
      if ((await this.repository.pendingOperations(1)).length) return;
      const operations = await this.repository.snapshotOperations();
      const payload = await this.cipher.encryptCheckpoint(targetSequence, operations);
      const chunks = splitCiphertext(payload);
      const checkpointId = randomId();
      adapter.uploadCheckpointStart(checkpointId, targetSequence, chunks.length);
      for (const [chunkIndex, data] of chunks.entries()) {
        if (!this.isCurrent(generation, adapter) || !adapter.isOpen) return;
        adapter.uploadCheckpointChunk(checkpointId, chunkIndex, data);
      }
      adapter.uploadCheckpointComplete(checkpointId, targetSequence);
    })();
    this.checkpointUploadPromise = flow;
    void flow.finally(() => {
      if (this.checkpointUploadPromise === flow) this.checkpointUploadPromise = undefined;
    });
    return flow;
  }

  async start(secret: string, device: DeviceRecord) {
    if (!validPairingSecret(secret)) return;
    if (this.adapter?.isOpen || this.reconnectPromise) return this.reconnectPromise;
    this.stopped = false;
    this.secret = secret;
    this.device = device;
    this.cipher = await createSyncCipher(secret);
    this.lastAppliedSequence = await this.repository.getLastAppliedSequence();
    this.snapshotSeeded = await this.repository.getSetting<boolean>(snapshotSeededSettingKey, false);
    await this.loadPeerControlState();
    await this.repository.requeueStaleSending(4_000);
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
    if (!this.adapter?.isReady || !this.device) {
      this.setState({ status: navigator.onLine ? configuredCloudflareSyncEndpoint() ? "pending" : "local" : "offline" });
      return;
    }
    await this.flushToServer();
  }

  async updateDeviceLabel(label: string) {
    if (!this.device) return;
    this.device = { ...this.device, label };
    this.adapter?.sendPresence(label);
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
    if (navigator.onLine) await this.handleOnline(true);
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

  private async checkExistingConnection() {
    if (!this.adapter?.isReady) return false;
    const healthy = await this.adapter.healthCheck();
    if (!healthy) return false;
    this.adapter.requestCatchup(this.lastAppliedSequence);
    this.setState({ status: "syncing", peerCount: this.currentPeers.size });
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
    this.clearReconnectTimer();
    this.connectionGeneration += 1;
    this.adapter?.close(1001, "offline");
    this.clearPeerState();
    this.setState({ status: "offline", peerCount: 0, peerStatuses: this.peerStatuses() });
  }

  stop() {
    this.stopped = true;
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
