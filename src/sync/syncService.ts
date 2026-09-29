import { joinRoom, type Room } from "trystero";
import type { DeviceRecord, SyncOperation } from "../types";
import type { Repository } from "../db/repository";
import { randomId, roomIdFromSecret, validPairingSecret } from "../db/identity";
import { fetchTurnIceServers } from "./turnCredentials";

export type SyncStatus = "local" | "offline" | "connecting" | "connected" | "syncing" | "pending" | "error";

const pendingPairingStorageKey = "project-one-pending-pairing-v1";
const pendingPairingCookieName = "project_one_pending_pairing_v1";
const pendingPairingMaxAgeMs = 24 * 60 * 60 * 1000;
const snapshotBatchSize = 50;
const pendingConnectionNoticeMs = 3_000;
const minimumResumeRestartIntervalMs = 3_000;

export interface SyncViewState {
  status: SyncStatus;
  peerCount: number;
  lastSyncedAt?: string;
}

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
type ReceiveAction = (handler: (data: unknown, peerId: string) => void | Promise<void>) => void;

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
      action.onMessage = (data, context) => handler(data, context.peerId);
    },
  ];
}

export class SyncService {
  private room?: Room;
  private listeners = new Set<(state: SyncViewState) => void>();
  private state: SyncViewState = { status: navigator.onLine ? "local" : "offline", peerCount: 0 };
  private peerDevices = new Map<string, string>();
  private flushing = new Set<string>();
  private snapshotting = new Set<string>();
  private snapshotSynced = new Set<string>();
  private snapshotWaiters = new Map<string, { resolve: (complete: boolean) => void; timer: number }>();
  private incomingSnapshots = new Map<string, { batchCount: number; received: Set<number> }>();
  private device?: DeviceRecord;
  private secret?: string;
  private pendingTimer?: number;
  private deliveryTimer?: number;
  private lastResumeRestartAt = 0;
  private restartPromise?: Promise<void>;
  private restarting = false;
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

  private clearConnectionTimers() {
    if (this.pendingTimer !== undefined) window.clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
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
    if (!this.room || !this.device) return;
    const peerIds = Object.keys(this.room.getPeers());
    if (!peerIds.length) return;
    await this.repository.requeueStaleSending(4_000);
    const [sendOperations] = makeMessageAction(this.room, "operations");
    await Promise.all(peerIds.map(async (peerId) => {
      await this.sendSnapshotToPeer(peerId, sendOperations);
      await this.flushToPeer(peerId, sendOperations);
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

  private hasUsablePeer(room = this.room) {
    if (!room) return false;
    return Object.values(room.getPeers()).some((connection) => {
      const connectionState = connection.connectionState;
      const iceConnectionState = connection.iceConnectionState;
      return connectionState === "connected" || iceConnectionState === "connected" || iceConnectionState === "completed";
    });
  }

  private async getIceServers() {
    const sixHoursMs = 6 * 60 * 60 * 1000;
    if (this.iceServersLoadedAt && Date.now() - this.iceServersLoadedAt < sixHoursMs) return this.iceServers;
    this.iceServers = await fetchTurnIceServers();
    this.iceServersLoadedAt = Date.now();
    return this.iceServers;
  }

  private async requestFreshSnapshots() {
    if (!this.room || !this.device) return;
    const peerIds = Object.keys(this.room.getPeers());
    if (!peerIds.length) return;
    const [sendSyncControl] = makeMessageAction(this.room, "sync");
    await Promise.allSettled(peerIds.map((peerId) => sendSyncControl({
      protocol: 1,
      type: "requestSnapshot",
      senderDeviceId: this.device!.deviceId,
      requestId: randomId(),
    } as SyncControlMessage, peerId)));
  }

  private async sendSnapshotToPeer(peerId: string, sendAction: SendAction, force = false) {
    // A requestSnapshot comes from the peer that needs bootstrap data. It
    // must win over the in-memory optimization, even if this transport peer
    // id was reused after another connection or a previous handshake.
    if (!this.device || this.snapshotting.has(peerId) || (!force && this.snapshotSynced.has(peerId))) return;
    this.snapshotting.add(peerId);
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
      const batches = operations.length
        ? Array.from(
            { length: Math.ceil(operations.length / snapshotBatchSize) },
            (_, index) => operations.slice(index * snapshotBatchSize, (index + 1) * snapshotBatchSize),
          )
        : [[]];
      for (const [batchIndex, batch] of batches.entries()) {
        if (!this.room || !Object.keys(this.room.getPeers()).includes(peerId)) {
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
      if (await completion) {
        this.snapshotSynced.add(peerId);
        this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
      } else {
        this.setState({ status: navigator.onLine ? "pending" : "offline" });
      }
    } catch {
      this.resolveSnapshot(peerId, snapshotId, false);
      this.setState({ status: navigator.onLine ? "pending" : "offline" });
    } finally {
      this.snapshotting.delete(peerId);
    }
  }

  private scheduleConnectionNotice() {
    if (this.stopped || this.restarting || this.restartPromise || !navigator.onLine || !this.room || !this.secret || !this.device) return;
    if (this.pendingTimer === undefined) {
      this.pendingTimer = window.setTimeout(() => {
        this.pendingTimer = undefined;
        if (this.room && !this.hasUsablePeer()) this.setState({ status: navigator.onLine ? "pending" : "offline", peerCount: 0 });
      }, pendingConnectionNoticeMs);
    }
  }

  private restartRoom() {
    if (this.restartPromise) return this.restartPromise;
    const secret = this.secret;
    const deviceId = this.device?.deviceId;
    if (this.stopped || !navigator.onLine || !secret || !this.device || !deviceId) return Promise.resolve();

    this.clearConnectionTimers();
    this.clearSnapshotState();
    this.restarting = true;
    const oldRoom = this.room;
    this.room = undefined;
    this.peerDevices.clear();
    this.snapshotting.clear();
    this.snapshotSynced.clear();
    this.setState({ status: "connecting", peerCount: 0 });

    const restart = (async () => {
      try {
        await oldRoom?.leave();
        if (this.stopped || !navigator.onLine || this.secret !== secret || this.device?.deviceId !== deviceId) return;
        this.restarting = false;
        await this.start(secret, this.device);
      } catch {
        this.setState({ status: navigator.onLine ? "pending" : "offline", peerCount: 0 });
        if (!this.stopped && navigator.onLine) this.scheduleConnectionNotice();
      } finally {
        this.restarting = false;
      }
    })();
    this.restartPromise = restart;
    void restart.finally(() => {
      if (this.restartPromise === restart) this.restartPromise = undefined;
    });
    return restart;
  }

  async start(secret: string, device: DeviceRecord) {
    if (!validPairingSecret(secret) || this.room || this.restarting) return;
    this.stopped = false;
    this.secret = secret;
    this.device = device;
    if (!navigator.onLine) {
      this.setState({ status: "offline" });
      return;
    }
    this.setState({ status: "connecting" });
    const [roomId, iceServers] = await Promise.all([roomIdFromSecret(secret), this.getIceServers()]);
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
          ],
        },
      },
      roomId,
      {
        onJoinError: () => {
          this.setState({ status: navigator.onLine ? "error" : "offline" });
          if (navigator.onLine) this.scheduleConnectionNotice();
        },
      },
    );
    this.room = room;
    this.startDeliveryWatch();
    const [sendHello, onHello] = makeMessageAction(room, "hello");
    const [sendOperations, onOperations] = makeMessageAction(room, "operations");
    const [sendAcknowledgements, onAcknowledgements] = makeMessageAction(room, "acks");
    const [sendSyncControl, onSyncControl] = makeMessageAction(room, "sync");
    const announcePeer = async (peerId: string) => {
      try {
        await sendHello({ protocol: 1, deviceId: device.deviceId, label: device.label }, peerId);
        await sendSyncControl({ protocol: 1, type: "requestSnapshot", senderDeviceId: device.deviceId, requestId: randomId() } as SyncControlMessage, peerId);
        await this.sendSnapshotToPeer(peerId, sendOperations, true);
        await this.flushToPeer(peerId, sendOperations);
      } catch {
        this.setState({ status: navigator.onLine ? "pending" : "offline" });
      }
    };

    room.onPeerJoin = (peerId) => {
      this.clearConnectionTimers();
      this.setState({ status: "connected", peerCount: Object.keys(room.getPeers()).length });
      void announcePeer(peerId);
    };

    room.onPeerLeave = (peerId) => {
      const deviceId = this.peerDevices.get(peerId);
      this.peerDevices.delete(peerId);
      this.snapshotting.delete(peerId);
      this.snapshotSynced.delete(peerId);
      this.clearSnapshotWaitersForPeer(peerId);
      for (const key of this.incomingSnapshots.keys()) if (key.startsWith(`${peerId}:`)) this.incomingSnapshots.delete(key);
      if (deviceId && !Array.from(this.peerDevices.values()).includes(deviceId)) void this.repository.forgetPeer(deviceId);
      const peerCount = Object.keys(room.getPeers()).length;
      this.setState({ status: peerCount ? "connected" : navigator.onLine ? "pending" : "offline", peerCount });
      // Keep the incumbent room subscribed. The returning phone announces as a
      // newcomer, which reconnects faster than making both phones repeatedly
      // leave/rejoin and avoids public-relay rate limits.
      if (!peerCount && navigator.onLine) this.scheduleConnectionNotice();
    };

    onHello((message: unknown, peerId: string) => {
      if (!isHello(message) || message.deviceId === device.deviceId) return;
      this.peerDevices.set(peerId, message.deviceId);
      void (async () => {
        await this.repository.rememberPeer(message.deviceId, message.label);
        await this.sendSnapshotToPeer(peerId, sendOperations);
        await this.flushToPeer(peerId, sendOperations);
      })();
    });

    onSyncControl((message: unknown, peerId: string) => {
      if (!isSyncControl(message) || message.senderDeviceId === device.deviceId) return;
      if (message.type === "snapshotComplete") {
        this.resolveSnapshot(peerId, message.snapshotId, true);
        return;
      }
      void (async () => {
        await this.sendSnapshotToPeer(peerId, sendOperations, true);
        await this.flushToPeer(peerId, sendOperations);
      })();
    });

    onOperations(async (message: unknown, peerId: string) => {
      if (!isOperations(message) || message.senderDeviceId === device.deviceId) return;
      try {
        this.setState({ status: "syncing" });
        const operationIds = await this.repository.applyRemoteOperations(message.operations);
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
        this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
      } catch {
        // Do not acknowledge a failed batch. The sender will time out and
        // retry the snapshot, while the live connection remains usable.
        this.setState({ status: navigator.onLine ? "pending" : "offline" });
      }
    });

    onAcknowledgements(async (message: unknown, peerId: string) => {
      if (!isAck(message) || message.senderDeviceId === device.deviceId) return;
      await this.repository.acknowledgeOperations(message.operationIds);
      await this.repository.markPeerSynced(message.senderDeviceId);
      this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
      await this.flushToPeer(peerId, sendOperations);
    });

    const peers = Object.keys(room.getPeers());
    this.setState({ status: peers.length ? "connected" : "connecting", peerCount: peers.length });
    if (peers.length) {
      peers.forEach((peerId) => void announcePeer(peerId));
    } else {
      this.scheduleConnectionNotice();
    }
  }

  private async flushToPeer(peerId: string, sendAction: SendAction) {
    if (!this.device || this.flushing.has(peerId)) return;
    this.flushing.add(peerId);
    try {
      while (true) {
        const pending = await this.repository.pendingOperations(50);
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
          this.setState({ status: navigator.onLine ? "pending" : "offline" });
          return;
        }
      }
    } finally {
      this.flushing.delete(peerId);
    }
  }

  async notifyLocalChange() {
    if (!this.room || !this.device) {
      this.setState({ status: navigator.onLine ? "local" : "offline" });
      return;
    }
    const [sendOperations] = makeMessageAction(this.room, "operations");
    await Promise.all(Object.keys(this.room.getPeers()).map((peerId) => this.flushToPeer(peerId, sendOperations)));
  }

  async updateDeviceLabel(label: string) {
    if (!this.device || !this.room) return;
    this.device = { ...this.device, label };
    const [sendHello] = makeMessageAction(this.room, "hello");
    await Promise.all(Object.keys(this.room.getPeers()).map((peerId) => sendHello({ protocol: 1, deviceId: this.device!.deviceId, label }, peerId)));
  }

  async handleOnline(forceReconnect = false) {
    if (this.stopped || !navigator.onLine || !this.secret || !this.device) return;
    if (this.restartPromise) {
      await this.restartPromise;
      if (this.room && this.hasUsablePeer()) {
        this.clearConnectionTimers();
        this.setState({ status: "connected", peerCount: Object.keys(this.room.getPeers()).length });
        await this.requestFreshSnapshots();
        return;
      }
      this.scheduleConnectionNotice();
      return;
    }
    if (!this.room) {
      await this.start(this.secret, this.device);
      return;
    }
    if (forceReconnect || !this.hasUsablePeer()) {
      const now = Date.now();
      if (!forceReconnect && now - this.lastResumeRestartAt < minimumResumeRestartIntervalMs) {
        this.scheduleConnectionNotice();
        return;
      }
      this.lastResumeRestartAt = now;
      await this.restartRoom();
      return;
    }
    this.clearConnectionTimers();
    this.setState({ status: "connected", peerCount: Object.keys(this.room.getPeers()).length });
    await this.requestFreshSnapshots();
  }

  handleHidden() {
    // Keep the current room. iOS may suspend this page, but a short app
    // switch can now resume the existing transport instead of always paying
    // for a brand-new signaling and ICE handshake.
  }

  handleOffline() {
    this.clearConnectionTimers();
    this.setState({ status: "offline", peerCount: 0 });
  }

  stop() {
    this.stopped = true;
    this.clearConnectionTimers();
    this.clearDeliveryTimer();
    this.clearSnapshotState();
    this.restarting = true;
    const room = this.room;
    this.room = undefined;
    this.peerDevices.clear();
    this.snapshotting.clear();
    this.snapshotSynced.clear();
    this.setState({ status: navigator.onLine ? "local" : "offline", peerCount: 0 });
    void room?.leave().finally(() => {
      this.restarting = false;
    });
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
