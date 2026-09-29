import { joinRoom, type Room } from "trystero";
import type { DeviceRecord, SyncOperation } from "../types";
import type { Repository } from "../db/repository";
import { roomIdFromSecret, validPairingSecret } from "../db/identity";

export type SyncStatus = "local" | "offline" | "connecting" | "connected" | "syncing" | "pending" | "error";

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
      { appId: "project-one-p2p-v1", password: secret },
      roomId,
      {
        onJoinError: () => this.setState({ status: navigator.onLine ? "error" : "offline" }),
      },
    );
    this.room = room;
    const [sendHello, onHello] = room.makeAction<any>("hello");
    const [sendOperations, onOperations] = room.makeAction<any>("operations");
    const [sendAcknowledgements, onAcknowledgements] = room.makeAction<any>("acks");

    room.onPeerJoin((peerId) => {
      this.setState({ status: "connected", peerCount: Object.keys(room.getPeers()).length });
      void sendHello({ protocol: 1, deviceId: device.deviceId, label: device.label }, peerId);
    });

    room.onPeerLeave((peerId) => {
      this.peerDevices.delete(peerId);
      const peerCount = Object.keys(room.getPeers()).length;
      this.setState({ status: peerCount ? "connected" : navigator.onLine ? "pending" : "offline", peerCount });
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
    this.setState({ status: peers.length ? "connected" : "pending", peerCount: peers.length });
  }

  private async flushToPeer(peerId: string, sendAction: SendAction) {
    if (!this.device || this.flushing.has(peerId)) return;
    this.flushing.add(peerId);
    try {
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

  async handleOnline() {
    if (!this.room && this.secret && this.device) await this.start(this.secret, this.device);
    else this.setState({ status: this.room && Object.keys(this.room.getPeers()).length ? "connected" : "pending" });
  }

  handleOffline() {
    this.setState({ status: "offline", peerCount: 0 });
  }

  stop() {
    this.room?.leave();
    this.room = undefined;
    this.peerDevices.clear();
    this.setState({ status: navigator.onLine ? "local" : "offline", peerCount: 0 });
  }
}

export function pairingSecretFromLocation() {
  const value = new URLSearchParams(location.hash.replace(/^#/, "")).get("pair");
  return validPairingSecret(value) ? value : undefined;
}

export function clearPairingSecretFromLocation() {
  if (!location.hash.includes("pair=")) return;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

export function createInviteUrl(secret: string) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = new URLSearchParams({ pair: secret }).toString();
  return url.toString();
}
