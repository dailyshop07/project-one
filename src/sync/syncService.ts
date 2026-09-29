import { joinRoom, type Room } from "trystero";
import type { DeviceRecord, SyncOperation } from "../types";
import type { Repository } from "../db/repository";
import { roomIdFromSecret, validPairingSecret } from "../db/identity";

export type SyncStatus = "local" | "offline" | "connecting" | "connected" | "syncing" | "pending" | "error";

const pendingPairingStorageKey = "project-one-pending-pairing-v1";
const pendingPairingMaxAgeMs = 24 * 60 * 60 * 1000;

export interface SyncViewState {
  status: SyncStatus;
  peerCount: number;
  lastSyncedAt?: string;
}

type HelloMessage = { protocol: 1; deviceId: string; label: string };
type OperationsMessage = { protocol: 1; senderDeviceId: string; operations: SyncOperation[] };
type AckMessage = { protocol: 1; senderDeviceId: string; operationIds: string[] };
type SendAction = (data: unknown, targetPeers?: string | string[] | null) => Promise<void[]>;

const isHello = (value: unknown): value is HelloMessage => {
  const message = value as Partial<HelloMessage>;
  return message?.protocol === 1 && typeof message.deviceId === "string" && typeof message.label === "string";
};

const isOperations = (value: unknown): value is OperationsMessage => {
  const message = value as Partial<OperationsMessage>;
  return message?.protocol === 1 && typeof message.senderDeviceId === "string" && Array.isArray(message.operations);
};

const isAck = (value: unknown): value is AckMessage => {
  const message = value as Partial<AckMessage>;
  return message?.protocol === 1 && typeof message.senderDeviceId === "string" && Array.isArray(message.operationIds);
};

export class SyncService {
  private room?: Room;
  private listeners = new Set<(state: SyncViewState) => void>();
  private state: SyncViewState = { status: navigator.onLine ? "local" : "offline", peerCount: 0 };
  private peerDevices = new Map<string, string>();
  private flushing = new Set<string>();
  private device?: DeviceRecord;
  private secret?: string;
  private pendingTimer?: number;
  private reconnectTimer?: number;
  private deliveryTimer?: number;

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
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.pendingTimer = undefined;
    this.reconnectTimer = undefined;
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
    const [sendOperations] = this.room.makeAction<any>("operations");
    await Promise.all(peerIds.map((peerId) => this.flushToPeer(peerId, sendOperations)));
  }

  private scheduleConnectionRetry() {
    this.clearConnectionTimers();
    this.pendingTimer = window.setTimeout(() => {
      if (this.room && !Object.keys(this.room.getPeers()).length) this.setState({ status: navigator.onLine ? "pending" : "offline", peerCount: 0 });
    }, 5_000);
    this.reconnectTimer = window.setTimeout(() => {
      if (!navigator.onLine || !this.room || Object.keys(this.room.getPeers()).length || !this.secret || !this.device) return;
      const secret = this.secret;
      const device = this.device;
      this.room.leave();
      this.room = undefined;
      void this.start(secret, device);
    }, 20_000);
  }

  async start(secret: string, device: DeviceRecord) {
    if (!validPairingSecret(secret) || this.room) return;
    this.secret = secret;
    this.device = device;
    if (!navigator.onLine) {
      this.setState({ status: "offline" });
      return;
    }
    this.setState({ status: "connecting" });
    const roomId = await roomIdFromSecret(secret);
    const room = joinRoom(
      {
        appId: "project-one-p2p-v1",
        password: secret,
        // Keep signaling focused on the relays that accept this app's encrypted events.
        // The package defaults currently include public relays that reject writes,
        // which creates noisy retries before the phones can see each other.
        relayConfig: {
          urls: [
            "wss://relay.damus.io",
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
          if (navigator.onLine) this.scheduleConnectionRetry();
        },
      },
    );
    this.room = room;
    this.startDeliveryWatch();
    const [sendHello, onHello] = room.makeAction<any>("hello");
    const [sendOperations, onOperations] = room.makeAction<any>("operations");
    const [sendAcknowledgements, onAcknowledgements] = room.makeAction<any>("acks");

    room.onPeerJoin((peerId) => {
      this.clearConnectionTimers();
      this.setState({ status: "connected", peerCount: Object.keys(room.getPeers()).length });
      void sendHello({ protocol: 1, deviceId: device.deviceId, label: device.label }, peerId);
      void this.retryDelivery();
    });

    room.onPeerLeave((peerId) => {
      const deviceId = this.peerDevices.get(peerId);
      this.peerDevices.delete(peerId);
      if (deviceId && !Array.from(this.peerDevices.values()).includes(deviceId)) void this.repository.forgetPeer(deviceId);
      const peerCount = Object.keys(room.getPeers()).length;
      this.setState({ status: peerCount ? "connected" : navigator.onLine ? "pending" : "offline", peerCount });
      if (!peerCount && navigator.onLine) this.scheduleConnectionRetry();
    });

    onHello((message: unknown, peerId: string) => {
      if (!isHello(message) || message.deviceId === device.deviceId) return;
      this.peerDevices.set(peerId, message.deviceId);
      void this.repository.rememberPeer(message.deviceId, message.label);
      void this.flushToPeer(peerId, sendOperations);
    });

    onOperations(async (message: unknown, peerId: string) => {
      if (!isOperations(message) || message.senderDeviceId === device.deviceId) return;
      this.setState({ status: "syncing" });
      const operationIds = await this.repository.applyRemoteOperations(message.operations);
      await sendAcknowledgements(
        { protocol: 1, senderDeviceId: device.deviceId, operationIds },
        peerId,
      );
      await this.repository.markPeerSynced(message.senderDeviceId);
      this.setState({ status: "connected", lastSyncedAt: new Date().toISOString() });
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
    if (!peers.length) this.scheduleConnectionRetry();
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
    const [sendOperations] = this.room.makeAction<any>("operations");
    await Promise.all(Object.keys(this.room.getPeers()).map((peerId) => this.flushToPeer(peerId, sendOperations)));
  }

  async updateDeviceLabel(label: string) {
    if (!this.device || !this.room) return;
    this.device = { ...this.device, label };
    const [sendHello] = this.room.makeAction<any>("hello");
    await Promise.all(Object.keys(this.room.getPeers()).map((peerId) => sendHello({ protocol: 1, deviceId: this.device!.deviceId, label }, peerId)));
  }

  async handleOnline() {
    if (!this.room && this.secret && this.device) await this.start(this.secret, this.device);
    else {
      const connected = Boolean(this.room && Object.keys(this.room.getPeers()).length);
      this.setState({ status: connected ? "connected" : "connecting" });
      if (!connected && this.room) this.scheduleConnectionRetry();
    }
  }

  handleOffline() {
    this.clearConnectionTimers();
    this.setState({ status: "offline", peerCount: 0 });
  }

  stop() {
    this.clearConnectionTimers();
    this.clearDeliveryTimer();
    this.room?.leave();
    this.room = undefined;
    this.peerDevices.clear();
    this.setState({ status: navigator.onLine ? "local" : "offline", peerCount: 0 });
  }
}

export function pairingSecretFromLocation() {
  const url = new URL(location.href);
  const value = new URLSearchParams(url.hash.replace(/^#/, "")).get("pair") ?? url.searchParams.get("pair");
  return validPairingSecret(value) ? value : undefined;
}

export function pendingPairingSecretFromStorage() {
  try {
    const raw = localStorage.getItem(pendingPairingStorageKey);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as { secret?: string; savedAt?: number };
    if (!validPairingSecret(value.secret ?? null) || !value.savedAt || Date.now() - value.savedAt > pendingPairingMaxAgeMs) {
      localStorage.removeItem(pendingPairingStorageKey);
      return undefined;
    }
    return value.secret;
  } catch {
    return undefined;
  }
}

export function rememberPairingSecretForInstall(secret: string) {
  if (!validPairingSecret(secret)) return;
  try {
    localStorage.setItem(pendingPairingStorageKey, JSON.stringify({ secret, savedAt: Date.now() }));
  } catch {
    // Safari private browsing may deny localStorage; the URL remains usable.
  }
}

export function clearPendingPairingSecret() {
  try {
    localStorage.removeItem(pendingPairingStorageKey);
  } catch {
    // Ignore storage cleanup failures.
  }
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
