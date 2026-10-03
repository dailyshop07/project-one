import { DurableObject } from "cloudflare:workers";

interface Env {
  SYNC_ROOM: DurableObjectNamespace<ProjectOneSyncRoom>;
}

type SyncPeer = { deviceId: string; label: string };
type Session = {
  sessionId: string;
  roomId: string;
  authenticated: boolean;
  deviceId?: string;
  label?: string;
};

const protocol = 1 as const;
const maxMessageBytes = 256 * 1024;
const roomIdPattern = /^[A-Za-z0-9_-]{40,64}$/;
const secretPattern = /^[A-Za-z0-9_-]{40,64}$/;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

const cleanLabel = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 40) || "iPhone" : "iPhone";

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

async function roomIdFromSecret(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`project-one-room:${secret}`));
  return bytesToBase64Url(new Uint8Array(digest));
}

const roomIdFromPath = (pathname: string) => {
  const match = pathname.match(/\/ws\/([A-Za-z0-9_-]+)$/);
  return match?.[1];
};

const peerFor = (session: Session): SyncPeer => ({ deviceId: session.deviceId!, label: session.label ?? "iPhone" });

const decodeText = (message: string | ArrayBuffer) => {
  const text = typeof message === "string" ? message : new TextDecoder().decode(message);
  if (new TextEncoder().encode(text).byteLength > maxMessageBytes) throw new Error("message too large");
  return JSON.parse(text) as unknown;
};

const isAuth = (value: unknown): value is { protocol: 1; kind: "auth"; secret: string; deviceId: string; label: string } => {
  const message = value as Partial<{ protocol: 1; kind: "auth"; secret: string; deviceId: string; label: string }>;
  return message?.protocol === protocol
    && message.kind === "auth"
    && typeof message.secret === "string"
    && secretPattern.test(message.secret)
    && typeof message.deviceId === "string"
    && message.deviceId.length > 0
    && message.deviceId.length <= 128
    && typeof message.label === "string";
};

const isPing = (value: unknown): value is { protocol: 1; kind: "ping"; nonce: string } => {
  const message = value as Partial<{ protocol: 1; kind: "ping"; nonce: string }>;
  return message?.protocol === protocol && message.kind === "ping" && typeof message.nonce === "string" && message.nonce.length <= 128;
};

const isClientMessage = (value: unknown): value is { protocol: 1; kind: "message"; senderDeviceId: string; targetDeviceId?: string; message: unknown } => {
  const message = value as Partial<{ protocol: 1; kind: "message"; senderDeviceId: string; targetDeviceId?: string; message: unknown }>;
  return message?.protocol === protocol
    && message.kind === "message"
    && typeof message.senderDeviceId === "string"
    && (message.targetDeviceId === undefined || typeof message.targetDeviceId === "string")
    && "message" in message;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const roomId = roomIdFromPath(url.pathname);
    if (roomId) {
      if (request.method !== "GET") return new Response("GET required", { status: 405 });
      if (!roomIdPattern.test(roomId)) return new Response("Invalid room", { status: 400 });
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
      const stub = env.SYNC_ROOM.getByName(roomId);
      return stub.fetch(request);
    }
    if (url.pathname.endsWith("/health")) return json({ ok: true, service: "project-one-sync" });
    return json({ ok: true, websocket: "/ws/:roomId", note: "Durable Object WebSocket sync relay" });
  },
};

export class ProjectOneSyncRoom extends DurableObject<Env> {
  private sessions = new Map<WebSocket, Session>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const socket of ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Session | null;
      if (attachment?.sessionId && attachment.roomId) this.sessions.set(socket, attachment);
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const roomId = roomIdFromPath(new URL(request.url).pathname);
    if (!roomId) return new Response("Invalid room", { status: 400 });
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    const session: Session = { sessionId: crypto.randomUUID(), roomId, authenticated: false };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(session);
    this.sessions.set(server, session);
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(socket: WebSocket, message: unknown) {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    } catch {
      // A mobile client may disappear between the session snapshot and send.
    }
  }

  private broadcast(message: unknown, except?: WebSocket, targetDeviceId?: string) {
    for (const [socket, session] of this.sessions) {
      if (socket === except || !session.authenticated || (targetDeviceId && session.deviceId !== targetDeviceId)) continue;
      this.send(socket, message);
    }
  }

  private reject(socket: WebSocket, code: string, message: string) {
    this.send(socket, { protocol, kind: "error", code, message });
    try {
      socket.close(1008, code);
    } catch {
      // Ignore a socket already closed by the browser.
    }
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer) {
    const session = this.sessions.get(socket);
    if (!session) return;
    let message: unknown;
    try {
      message = decodeText(rawMessage);
    } catch {
      this.reject(socket, "invalid_message", "Invalid sync message");
      return;
    }

    if (isPing(message)) {
      this.send(socket, { protocol, kind: "pong", nonce: message.nonce });
      return;
    }

    if (!session.authenticated) {
      if (!isAuth(message)) {
        this.reject(socket, "unauthorized", "Authentication required");
        return;
      }
      if (await roomIdFromSecret(message.secret) !== session.roomId) {
        this.reject(socket, "unauthorized", "Room authentication failed");
        return;
      }
      for (const [otherSocket, otherSession] of this.sessions) {
        if (otherSocket !== socket && otherSession.authenticated && otherSession.deviceId === message.deviceId) {
          try { otherSocket.close(4001, "replaced"); } catch { /* already closed */ }
          this.sessions.delete(otherSocket);
        }
      }
      session.authenticated = true;
      session.deviceId = message.deviceId;
      session.label = cleanLabel(message.label);
      socket.serializeAttachment(session);
      const peers = Array.from(this.sessions.values()).filter((peer) => peer.authenticated && peer.deviceId !== session.deviceId).map(peerFor);
      this.send(socket, { protocol, kind: "welcome", peers });
      this.broadcast({ protocol, kind: "peer_joined", peer: peerFor(session) }, socket);
      return;
    }

    if (!isClientMessage(message) || message.senderDeviceId !== session.deviceId) {
      this.reject(socket, "invalid_message", "Invalid sync message");
      return;
    }

    const payload = message.message as Partial<{ protocol: 1; deviceId: string; label: string }>;
    if (payload?.protocol === protocol && typeof payload.deviceId === "string" && payload.deviceId === session.deviceId && typeof payload.label === "string") {
      session.label = cleanLabel(payload.label);
      socket.serializeAttachment(session);
      this.broadcast({ protocol, kind: "peer_joined", peer: peerFor(session) }, socket);
    }
    this.broadcast({ protocol, kind: "message", from: peerFor(session), message: message.message }, socket, message.targetDeviceId);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    const session = this.sessions.get(socket);
    this.sessions.delete(socket);
    if (session?.authenticated && session.deviceId) this.broadcast({ protocol, kind: "peer_left", deviceId: session.deviceId }, socket);
    try { socket.close(code, reason); } catch { /* auto-close may already have completed */ }
  }

  async webSocketError(socket: WebSocket) {
    await this.webSocketClose(socket, 1011, "socket error");
  }
}
