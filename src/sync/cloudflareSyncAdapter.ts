import type { DeviceRecord, StoredSyncEvent, SyncOperation } from "../types";

export type SyncPeer = { deviceId: string; label: string };
export type PublishAccepted = { eventId: string; sequence: number };

export type CloudflareSyncEvent =
  | { type: "open"; peers: SyncPeer[]; latestSequence: number; needsSnapshot: boolean }
  | { type: "catchup"; events: StoredSyncEvent[] }
  | { type: "catchupComplete"; latestSequence: number }
  | { type: "checkpointStart"; checkpointId: string; baseSequence: number; chunkCount: number }
  | { type: "checkpointChunk"; checkpointId: string; chunkIndex: number; data: string }
  | { type: "checkpointComplete"; checkpointId: string; baseSequence: number }
  | { type: "checkpointRequest"; requestId: string; targetSequence: number }
  | { type: "events"; from: SyncPeer; events: StoredSyncEvent[] }
  | { type: "publishAck"; requestId: string; accepted: PublishAccepted[]; latestSequence: number }
  | { type: "peerJoined"; peer: SyncPeer }
  | { type: "peerLeft"; deviceId: string }
  | { type: "error"; error?: unknown }
  | { type: "close"; code: number; reason: string };

type AdapterMessage =
  | { protocol: 2; kind: "welcome"; peers: SyncPeer[]; latestSequence: number; needsSnapshot: boolean }
  | { protocol: 2; kind: "catchup"; events: StoredSyncEvent[] }
  | { protocol: 2; kind: "catchup_complete"; latestSequence: number }
  | { protocol: 2; kind: "checkpoint_start"; checkpointId: string; baseSequence: number; chunkCount: number }
  | { protocol: 2; kind: "checkpoint_chunk"; checkpointId: string; chunkIndex: number; data: string }
  | { protocol: 2; kind: "checkpoint_complete"; checkpointId: string; baseSequence: number }
  | { protocol: 2; kind: "checkpoint_request"; requestId: string; targetSequence: number }
  | { protocol: 2; kind: "events"; from: SyncPeer; events: StoredSyncEvent[] }
  | { protocol: 2; kind: "publish_ack"; requestId: string; accepted: PublishAccepted[]; latestSequence: number }
  | { protocol: 2; kind: "peer_joined"; peer: SyncPeer }
  | { protocol: 2; kind: "peer_left"; deviceId: string }
  | { protocol: 2; kind: "pong"; nonce: string }
  | { protocol: 2; kind: "error"; code: string; message?: string };

const protocol = 2 as const;
const authTimeoutMs = 12_000;
const healthTimeoutMs = 2_000;
const healthIntervalMs = 15_000;
const publishTimeoutMs = 20_000;

const isPeer = (value: unknown): value is SyncPeer => {
  const peer = value as Partial<SyncPeer>;
  return Boolean(peer && typeof peer.deviceId === "string" && typeof peer.label === "string");
};

const isStoredEvent = (value: unknown): value is StoredSyncEvent => {
  const event = value as Partial<StoredSyncEvent>;
  return Boolean(
    event
    && Number.isSafeInteger(event.sequence)
    && event.sequence! > 0
    && typeof event.eventId === "string"
    && event.eventId.length > 0
    && typeof event.senderDeviceId === "string"
    && typeof event.createdAt === "string"
    && typeof event.encrypted === "boolean"
    && typeof event.payload === "string",
  );
};

const isAccepted = (value: unknown): value is PublishAccepted => {
  const accepted = value as Partial<PublishAccepted>;
  return Boolean(accepted && typeof accepted.eventId === "string" && Number.isSafeInteger(accepted.sequence) && accepted.sequence! > 0);
};

const isAdapterMessage = (value: unknown): value is AdapterMessage => {
  const message = value as Partial<AdapterMessage>;
  if (!message || message.protocol !== protocol || typeof message.kind !== "string") return false;
  if (message.kind === "welcome") {
    return Array.isArray(message.peers)
      && message.peers.every(isPeer)
      && Number.isSafeInteger(message.latestSequence)
      && typeof message.needsSnapshot === "boolean";
  }
  if (message.kind === "catchup") return Array.isArray(message.events) && message.events.every(isStoredEvent);
  if (message.kind === "catchup_complete") return Number.isSafeInteger(message.latestSequence);
  if (message.kind === "checkpoint_start") {
    return typeof message.checkpointId === "string"
      && Number.isSafeInteger(message.baseSequence)
      && Number.isSafeInteger(message.chunkCount)
      && message.chunkCount! > 0;
  }
  if (message.kind === "checkpoint_chunk") {
    return typeof message.checkpointId === "string" && Number.isSafeInteger(message.chunkIndex) && typeof message.data === "string";
  }
  if (message.kind === "checkpoint_complete") return typeof message.checkpointId === "string" && Number.isSafeInteger(message.baseSequence);
  if (message.kind === "checkpoint_request") return typeof message.requestId === "string" && Number.isSafeInteger(message.targetSequence);
  if (message.kind === "events") return isPeer(message.from) && Array.isArray(message.events) && message.events.every(isStoredEvent);
  if (message.kind === "publish_ack") {
    return typeof message.requestId === "string"
      && Array.isArray(message.accepted)
      && message.accepted.every(isAccepted)
      && Number.isSafeInteger(message.latestSequence);
  }
  if (message.kind === "peer_joined") return isPeer(message.peer);
  if (message.kind === "peer_left") return typeof message.deviceId === "string";
  if (message.kind === "pong") return typeof message.nonce === "string";
  return message.kind === "error" && typeof message.code === "string";
};

const parseIncomingMessage = async (data: unknown): Promise<unknown> => {
  if (typeof data === "string") return JSON.parse(data) as unknown;
  if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data)) as unknown;
  if (typeof Blob !== "undefined" && data instanceof Blob) return JSON.parse(await data.text()) as unknown;
  return undefined;
};

const makeWebSocketUrl = (endpoint: string, roomId: string) => {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/ws/${encodeURIComponent(roomId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

type PublishWaiter = {
  resolve: (accepted: PublishAccepted[]) => void;
  reject: (error: Error) => void;
  timer: number;
};

export class CloudflareSyncAdapter {
  private socket?: WebSocket;
  private listeners = new Set<(event: CloudflareSyncEvent) => void>();
  private device?: DeviceRecord;
  private authenticated = false;
  private ready = false;
  private closedByCaller = false;
  private authTimer?: number;
  private healthTimer?: number;
  private connectPromise?: Promise<void>;
  private welcomePeers: SyncPeer[] = [];
  private welcomeLatestSequence = 0;
  private welcomeNeedsSnapshot = false;
  private healthWaiters = new Map<string, { resolve: (healthy: boolean) => void; timer: number }>();
  private publishWaiters = new Map<string, PublishWaiter>();

  constructor(private readonly endpoint: string) {}

  subscribe(listener: (event: CloudflareSyncEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: CloudflareSyncEvent) {
    this.listeners.forEach((listener) => listener(event));
  }

  get isOpen() {
    return this.authenticated && this.socket?.readyState === WebSocket.OPEN;
  }

  get isReady() {
    return this.isOpen && this.ready;
  }

  private sendRaw(message: unknown) {
    if (!this.isOpen) throw new Error("同步连接尚未打开");
    this.socket!.send(JSON.stringify(message));
  }

  async connect(input: { roomId: string; secret: string; device: DeviceRecord; lastAppliedSequence: number }) {
    if (this.isReady) return;
    if (this.connectPromise) return this.connectPromise;
    this.device = input.device;
    this.closedByCaller = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (this.authTimer !== undefined) window.clearTimeout(this.authTimer);
        this.authTimer = undefined;
        if (error) reject(error);
        else resolve();
      };

      let socket: WebSocket;
      try {
        socket = new WebSocket(makeWebSocketUrl(this.endpoint, input.roomId));
      } catch (error) {
        settle(error instanceof Error ? error : new Error("无法创建同步连接"));
        return;
      }
      this.socket = socket;
      this.authenticated = false;
      this.ready = false;
      this.welcomePeers = [];
      this.welcomeLatestSequence = 0;
      this.welcomeNeedsSnapshot = false;
      this.authTimer = window.setTimeout(() => settle(new Error("同步连接认证或补齐超时")), authTimeoutMs);

      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({
            protocol,
            kind: "auth",
            secret: input.secret,
            deviceId: input.device.deviceId,
            label: input.device.label,
            lastAppliedSequence: Number.isSafeInteger(input.lastAppliedSequence) ? input.lastAppliedSequence : 0,
          }));
        } catch (error) {
          settle(error instanceof Error ? error : new Error("无法发送同步认证"));
        }
      };
      socket.onmessage = (event) => {
        void parseIncomingMessage(event.data).then((raw) => {
          if (!isAdapterMessage(raw)) return;
          if (raw.kind === "welcome") {
            this.authenticated = true;
            if (this.authTimer !== undefined) window.clearTimeout(this.authTimer);
            this.authTimer = undefined;
            this.welcomePeers = raw.peers.filter((peer) => peer.deviceId !== this.device?.deviceId);
            this.welcomeLatestSequence = raw.latestSequence;
            this.welcomeNeedsSnapshot = raw.needsSnapshot;
            return;
          }
          if (raw.kind === "catchup") {
            this.emit({ type: "catchup", events: raw.events });
            return;
          }
          if (raw.kind === "catchup_complete") {
            this.ready = true;
            this.startHealthWatch();
            this.emit({ type: "catchupComplete", latestSequence: raw.latestSequence });
            this.emit({ type: "open", peers: this.welcomePeers, latestSequence: Math.max(this.welcomeLatestSequence, raw.latestSequence), needsSnapshot: this.welcomeNeedsSnapshot });
            settle();
            return;
          }
          if (raw.kind === "checkpoint_start") {
            this.emit({ type: "checkpointStart", checkpointId: raw.checkpointId, baseSequence: raw.baseSequence, chunkCount: raw.chunkCount });
            return;
          }
          if (raw.kind === "checkpoint_chunk") {
            this.emit({ type: "checkpointChunk", checkpointId: raw.checkpointId, chunkIndex: raw.chunkIndex, data: raw.data });
            return;
          }
          if (raw.kind === "checkpoint_complete") {
            this.emit({ type: "checkpointComplete", checkpointId: raw.checkpointId, baseSequence: raw.baseSequence });
            return;
          }
          if (raw.kind === "checkpoint_request") {
            this.emit({ type: "checkpointRequest", requestId: raw.requestId, targetSequence: raw.targetSequence });
            return;
          }
          if (raw.kind === "events") {
            if (raw.from.deviceId !== this.device?.deviceId) this.emit({ type: "events", from: raw.from, events: raw.events });
            return;
          }
          if (raw.kind === "publish_ack") {
            const waiter = this.publishWaiters.get(raw.requestId);
            if (waiter) {
              window.clearTimeout(waiter.timer);
              this.publishWaiters.delete(raw.requestId);
              waiter.resolve(raw.accepted);
            }
            this.emit({ type: "publishAck", requestId: raw.requestId, accepted: raw.accepted, latestSequence: raw.latestSequence });
            return;
          }
          if (raw.kind === "peer_joined") {
            if (raw.peer.deviceId !== this.device?.deviceId) this.emit({ type: "peerJoined", peer: raw.peer });
            return;
          }
          if (raw.kind === "peer_left") {
            this.emit({ type: "peerLeft", deviceId: raw.deviceId });
            return;
          }
          if (raw.kind === "pong") {
            const waiter = this.healthWaiters.get(raw.nonce);
            if (!waiter) return;
            window.clearTimeout(waiter.timer);
            this.healthWaiters.delete(raw.nonce);
            waiter.resolve(true);
            return;
          }
          this.emit({ type: "error", error: new Error(raw.message ?? raw.code) });
          if (!this.authenticated) settle(new Error(raw.message ?? "同步认证失败"));
        }).catch((error) => this.emit({ type: "error", error }));
      };
      socket.onerror = (event) => {
        this.emit({ type: "error", error: event });
        if (!settled) settle(new Error("同步 WebSocket 连接失败"));
      };
      socket.onclose = (event) => {
        this.authenticated = false;
        this.ready = false;
        this.stopHealthWatch();
        for (const waiter of this.healthWaiters.values()) {
          window.clearTimeout(waiter.timer);
          waiter.resolve(false);
        }
        this.healthWaiters.clear();
        for (const waiter of this.publishWaiters.values()) {
          window.clearTimeout(waiter.timer);
          waiter.reject(new Error("同步连接已关闭，事件仍保留在本地待上传队列"));
        }
        this.publishWaiters.clear();
        if (!settled) settle(new Error("同步 WebSocket 已关闭"));
        if (this.socket === socket) this.socket = undefined;
        if (!this.closedByCaller) this.emit({ type: "close", code: event.code, reason: event.reason });
      };
    }).finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  async publish(events: Array<{ eventId: string; senderDeviceId: string; createdAt: string; encrypted: boolean; payload: string }>) {
    if (!this.isReady || !this.device || !events.length) return [];
    const requestId = crypto.randomUUID();
    return new Promise<PublishAccepted[]>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.publishWaiters.delete(requestId);
        reject(new Error("同步服务器确认超时"));
      }, publishTimeoutMs);
      this.publishWaiters.set(requestId, { resolve, reject, timer });
      try {
        this.sendRaw({ protocol, kind: "publish", requestId, events });
      } catch (error) {
        window.clearTimeout(timer);
        this.publishWaiters.delete(requestId);
        reject(error instanceof Error ? error : new Error("无法上传同步事件"));
      }
    });
  }

  requestCatchup(lastAppliedSequence: number) {
    if (!this.isOpen) return;
    this.ready = false;
    this.sendRaw({ protocol, kind: "catchup_request", lastAppliedSequence });
  }

  ackCatchup(lastAppliedSequence: number) {
    if (!this.isOpen) return;
    this.sendRaw({ protocol, kind: "catchup_ack", lastAppliedSequence });
  }

  ackCheckpoint(checkpointId: string, baseSequence: number) {
    if (!this.isOpen) return;
    this.sendRaw({ protocol, kind: "checkpoint_ack", checkpointId, baseSequence });
  }

  uploadCheckpointStart(checkpointId: string, baseSequence: number, chunkCount: number) {
    this.sendRaw({ protocol, kind: "checkpoint_start", checkpointId, baseSequence, chunkCount });
  }

  uploadCheckpointChunk(checkpointId: string, chunkIndex: number, data: string) {
    this.sendRaw({ protocol, kind: "checkpoint_chunk", checkpointId, chunkIndex, data });
  }

  uploadCheckpointComplete(checkpointId: string, baseSequence: number) {
    this.sendRaw({ protocol, kind: "checkpoint_complete", checkpointId, baseSequence });
  }

  sendPresence(label: string) {
    if (!this.isOpen || !this.device) return;
    this.sendRaw({ protocol, kind: "presence", label });
  }

  async healthCheck() {
    if (!this.isOpen) return false;
    const nonce = crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        this.healthWaiters.delete(nonce);
        resolve(false);
      }, healthTimeoutMs);
      this.healthWaiters.set(nonce, { resolve, timer });
      try {
        this.sendRaw({ protocol, kind: "ping", nonce });
      } catch {
        window.clearTimeout(timer);
        this.healthWaiters.delete(nonce);
        resolve(false);
      }
    });
  }

  private startHealthWatch() {
    this.stopHealthWatch();
    this.healthTimer = window.setInterval(() => {
      void this.healthCheck().then((healthy) => {
        if (!healthy && this.socket && this.socket.readyState < WebSocket.CLOSING) {
          try { this.socket.close(4000, "health check failed"); } catch { /* already closed */ }
        }
      });
    }, healthIntervalMs);
  }

  private stopHealthWatch() {
    if (this.healthTimer !== undefined) window.clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }

  close(code = 1000, reason = "client closed") {
    this.closedByCaller = true;
    this.stopHealthWatch();
    if (this.authTimer !== undefined) window.clearTimeout(this.authTimer);
    this.authTimer = undefined;
    for (const waiter of this.healthWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.healthWaiters.clear();
    for (const waiter of this.publishWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.reject(new Error("同步连接已关闭，事件仍保留在本地待上传队列"));
    }
    this.publishWaiters.clear();
    this.authenticated = false;
    this.ready = false;
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState >= WebSocket.CLOSING) return;
    try {
      socket.close(code, reason);
    } catch {
      // Safari may already have disposed a background connection.
    }
  }
}

export function configuredCloudflareSyncEndpoint() {
  const value = import.meta.env.VITE_CLOUDFLARE_SYNC_URL;
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}
