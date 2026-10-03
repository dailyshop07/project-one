import type { DeviceRecord } from "../types";

export type SyncPeer = { deviceId: string; label: string };

export type CloudflareSyncEvent =
  | { type: "open"; peers: SyncPeer[] }
  | { type: "peerJoined"; peer: SyncPeer }
  | { type: "peerLeft"; deviceId: string }
  | { type: "message"; from: SyncPeer; message: unknown }
  | { type: "error"; error?: unknown }
  | { type: "close"; code: number; reason: string };

type AdapterMessage =
  | { protocol: 1; kind: "welcome"; peers: SyncPeer[] }
  | { protocol: 1; kind: "peer_joined"; peer: SyncPeer }
  | { protocol: 1; kind: "peer_left"; deviceId: string }
  | { protocol: 1; kind: "message"; from: SyncPeer; message: unknown }
  | { protocol: 1; kind: "pong"; nonce: string }
  | { protocol: 1; kind: "error"; code: string; message?: string };

const authTimeoutMs = 8_000;
const healthTimeoutMs = 2_000;
const healthIntervalMs = 15_000;

const isPeer = (value: unknown): value is SyncPeer => {
  const peer = value as Partial<SyncPeer>;
  return Boolean(peer && typeof peer.deviceId === "string" && typeof peer.label === "string");
};

const isAdapterMessage = (value: unknown): value is AdapterMessage => {
  const message = value as Partial<AdapterMessage>;
  if (!message || message.protocol !== 1 || typeof message.kind !== "string") return false;
  if (message.kind === "welcome") return Array.isArray(message.peers) && message.peers.every(isPeer);
  if (message.kind === "peer_joined") return isPeer(message.peer);
  if (message.kind === "peer_left") return typeof message.deviceId === "string";
  if (message.kind === "message") return isPeer(message.from) && "message" in message;
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

export class CloudflareSyncAdapter {
  private socket?: WebSocket;
  private listeners = new Set<(event: CloudflareSyncEvent) => void>();
  private device?: DeviceRecord;
  private authenticated = false;
  private closedByCaller = false;
  private authTimer?: number;
  private healthTimer?: number;
  private connectPromise?: Promise<void>;
  private healthWaiters = new Map<string, { resolve: (healthy: boolean) => void; timer: number }>();

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

  async connect(input: { roomId: string; secret: string; device: DeviceRecord }) {
    if (this.isOpen) return;
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
      this.authTimer = window.setTimeout(() => settle(new Error("同步连接认证超时")), authTimeoutMs);

      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({
            protocol: 1,
            kind: "auth",
            secret: input.secret,
            deviceId: input.device.deviceId,
            label: input.device.label,
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
            this.startHealthWatch();
            this.emit({ type: "open", peers: raw.peers.filter((peer) => peer.deviceId !== this.device?.deviceId) });
            settle();
          } else if (raw.kind === "peer_joined" && raw.peer.deviceId !== this.device?.deviceId) {
            this.emit({ type: "peerJoined", peer: raw.peer });
          } else if (raw.kind === "peer_left") {
            this.emit({ type: "peerLeft", deviceId: raw.deviceId });
          } else if (raw.kind === "message" && raw.from.deviceId !== this.device?.deviceId) {
            this.emit({ type: "message", from: raw.from, message: raw.message });
          } else if (raw.kind === "pong") {
            const waiter = this.healthWaiters.get(raw.nonce);
            if (!waiter) return;
            window.clearTimeout(waiter.timer);
            this.healthWaiters.delete(raw.nonce);
            waiter.resolve(true);
          } else if (raw.kind === "error") {
            this.emit({ type: "error", error: new Error(raw.message ?? raw.code) });
            if (!this.authenticated) settle(new Error(raw.message ?? "同步认证失败"));
          }
        }).catch((error) => this.emit({ type: "error", error }));
      };
      socket.onerror = (event) => {
        this.emit({ type: "error", error: event });
        if (!settled) settle(new Error("同步 WebSocket 连接失败"));
      };
      socket.onclose = (event) => {
        this.authenticated = false;
        this.stopHealthWatch();
        for (const waiter of this.healthWaiters.values()) {
          window.clearTimeout(waiter.timer);
          waiter.resolve(false);
        }
        this.healthWaiters.clear();
        if (!settled) settle(new Error("同步 WebSocket 已关闭"));
        if (this.socket === socket) this.socket = undefined;
        if (!this.closedByCaller) this.emit({ type: "close", code: event.code, reason: event.reason });
      };
    }).finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  async send(message: unknown, targetDeviceId?: string) {
    if (!this.isOpen || !this.device) throw new Error("同步连接尚未打开");
    this.socket!.send(JSON.stringify({
      protocol: 1,
      kind: "message",
      senderDeviceId: this.device.deviceId,
      targetDeviceId,
      message,
    }));
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
        this.socket!.send(JSON.stringify({ protocol: 1, kind: "ping", nonce }));
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
    this.authenticated = false;
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
