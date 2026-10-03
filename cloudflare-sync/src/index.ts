import { DurableObject } from "cloudflare:workers";

interface Env {
  SYNC_ROOM: DurableObjectNamespace<ProjectOneSyncRoom>;
}

type SyncPeer = { deviceId: string; label: string };
type StoredSyncEvent = {
  sequence: number;
  eventId: string;
  senderDeviceId: string;
  createdAt: string;
  encrypted: boolean;
  payload: string;
};
type PublishEvent = Omit<StoredSyncEvent, "sequence">;
type Session = {
  sessionId: string;
  roomId: string;
  authenticated: boolean;
  deviceId?: string;
  label?: string;
  lastAppliedSequence: number;
  catchingUp: boolean;
  pendingCatchupThrough?: number;
  pendingCheckpointId?: string;
  pendingCheckpointBase?: number;
};
type CheckpointRow = {
  checkpointId: string;
  baseSequence: number;
  chunkCount: number;
};

const protocol = 2 as const;
const maxMessageBytes = 256 * 1024;
const maxEventPayloadBytes = 220 * 1024;
const maxPublishEvents = 100;
const catchupPageSize = 50;
const maxCheckpointChunks = 10_000;
const roomIdPattern = /^[A-Za-z0-9_-]{40,64}$/;
const secretPattern = /^[A-Za-z0-9_-]{40,64}$/;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

const cleanLabel = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 40) || "iPhone" : "iPhone";
const isSafeSequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

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

const isAuth = (value: unknown): value is {
  protocol: 2;
  kind: "auth";
  secret: string;
  deviceId: string;
  label: string;
  lastAppliedSequence: number;
} => {
  const message = value as Partial<{
    protocol: 2;
    kind: "auth";
    secret: string;
    deviceId: string;
    label: string;
    lastAppliedSequence: number;
  }>;
  return message?.protocol === protocol
    && message.kind === "auth"
    && typeof message.secret === "string"
    && secretPattern.test(message.secret)
    && typeof message.deviceId === "string"
    && message.deviceId.length > 0
    && message.deviceId.length <= 128
    && typeof message.label === "string"
    && isSafeSequence(message.lastAppliedSequence);
};

const isPing = (value: unknown): value is { protocol: 2; kind: "ping"; nonce: string } => {
  const message = value as Partial<{ protocol: 2; kind: "ping"; nonce: string }>;
  return message?.protocol === protocol && message.kind === "ping" && typeof message.nonce === "string" && message.nonce.length <= 128;
};

const isPublishEvent = (value: unknown): value is PublishEvent => {
  const event = value as Partial<PublishEvent>;
  return Boolean(
    event
    && typeof event.eventId === "string"
    && event.eventId.length > 0
    && event.eventId.length <= 256
    && typeof event.senderDeviceId === "string"
    && event.senderDeviceId.length > 0
    && event.senderDeviceId.length <= 128
    && typeof event.createdAt === "string"
    && typeof event.encrypted === "boolean"
    && typeof event.payload === "string"
    && new TextEncoder().encode(event.payload).byteLength <= maxEventPayloadBytes,
  );
};

const isPublish = (value: unknown): value is {
  protocol: 2;
  kind: "publish";
  requestId: string;
  events: PublishEvent[];
} => {
  const message = value as Partial<{ protocol: 2; kind: "publish"; requestId: string; events: PublishEvent[] }>;
  return message?.protocol === protocol
    && message.kind === "publish"
    && typeof message.requestId === "string"
    && message.requestId.length > 0
    && Array.isArray(message.events)
    && message.events.length > 0
    && message.events.length <= maxPublishEvents
    && message.events.every(isPublishEvent);
};

const isCatchupRequest = (value: unknown): value is { protocol: 2; kind: "catchup_request"; lastAppliedSequence: number } => {
  const message = value as Partial<{ protocol: 2; kind: "catchup_request"; lastAppliedSequence: number }>;
  return message?.protocol === protocol && message.kind === "catchup_request" && isSafeSequence(message.lastAppliedSequence);
};

const isCatchupAck = (value: unknown): value is { protocol: 2; kind: "catchup_ack"; lastAppliedSequence: number } => {
  const message = value as Partial<{ protocol: 2; kind: "catchup_ack"; lastAppliedSequence: number }>;
  return message?.protocol === protocol && message.kind === "catchup_ack" && isSafeSequence(message.lastAppliedSequence);
};

const isCheckpointStart = (value: unknown): value is {
  protocol: 2;
  kind: "checkpoint_start";
  checkpointId: string;
  baseSequence: number;
  chunkCount: number;
} => {
  const message = value as Partial<{ protocol: 2; kind: "checkpoint_start"; checkpointId: string; baseSequence: number; chunkCount: number }>;
  return message?.protocol === protocol
    && message.kind === "checkpoint_start"
    && typeof message.checkpointId === "string"
    && message.checkpointId.length > 0
    && message.checkpointId.length <= 256
    && isSafeSequence(message.baseSequence)
    && Number.isSafeInteger(message.chunkCount)
    && message.chunkCount! > 0
    && message.chunkCount! <= maxCheckpointChunks;
};

const isCheckpointChunk = (value: unknown): value is {
  protocol: 2;
  kind: "checkpoint_chunk";
  checkpointId: string;
  chunkIndex: number;
  data: string;
} => {
  const message = value as Partial<{ protocol: 2; kind: "checkpoint_chunk"; checkpointId: string; chunkIndex: number; data: string }>;
  return message?.protocol === protocol
    && message.kind === "checkpoint_chunk"
    && typeof message.checkpointId === "string"
    && Number.isSafeInteger(message.chunkIndex)
    && message.chunkIndex! >= 0
    && message.chunkIndex! < maxCheckpointChunks
    && typeof message.data === "string"
    && new TextEncoder().encode(message.data).byteLength <= 60_000;
};

const isCheckpointComplete = (value: unknown): value is { protocol: 2; kind: "checkpoint_complete"; checkpointId: string; baseSequence: number } => {
  const message = value as Partial<{ protocol: 2; kind: "checkpoint_complete"; checkpointId: string; baseSequence: number }>;
  return message?.protocol === protocol
    && message.kind === "checkpoint_complete"
    && typeof message.checkpointId === "string"
    && isSafeSequence(message.baseSequence);
};

const isCheckpointAck = (value: unknown): value is { protocol: 2; kind: "checkpoint_ack"; checkpointId: string; baseSequence: number } => {
  const message = value as Partial<{ protocol: 2; kind: "checkpoint_ack"; checkpointId: string; baseSequence: number }>;
  return message?.protocol === protocol
    && message.kind === "checkpoint_ack"
    && typeof message.checkpointId === "string"
    && isSafeSequence(message.baseSequence);
};

const isPresence = (value: unknown): value is { protocol: 2; kind: "presence"; label: string } => {
  const message = value as Partial<{ protocol: 2; kind: "presence"; label: string }>;
  return message?.protocol === protocol && message.kind === "presence" && typeof message.label === "string";
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
    if (url.pathname.endsWith("/health")) return json({ ok: true, service: "project-one-sync", protocol });
    return json({ ok: true, websocket: "/ws/:roomId", note: "Durable Object SQLite event log with WebSocket catch-up" });
  },
};

export class ProjectOneSyncRoom extends DurableObject<Env> {
  private sessions = new Map<WebSocket, Session>();
  private checkpointRequestInFlight?: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sync_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        sender_device_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        encrypted INTEGER NOT NULL,
        payload TEXT NOT NULL
      )
    `);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS sync_events_event_id_idx ON sync_events(event_id)");
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sync_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        base_sequence INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        complete INTEGER NOT NULL DEFAULT 0
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sync_checkpoint_parts (
        checkpoint_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (checkpoint_id, chunk_index)
      )
    `);
    for (const socket of ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Session | null;
      if (attachment?.sessionId && attachment.roomId) {
        attachment.lastAppliedSequence = isSafeSequence(attachment.lastAppliedSequence) ? attachment.lastAppliedSequence : 0;
        attachment.catchingUp = Boolean(attachment.catchingUp);
        this.sessions.set(socket, attachment);
      }
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const roomId = roomIdFromPath(new URL(request.url).pathname);
    if (!roomId) return new Response("Invalid room", { status: 400 });
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    const session: Session = {
      sessionId: crypto.randomUUID(),
      roomId,
      authenticated: false,
      lastAppliedSequence: 0,
      catchingUp: false,
    };
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

  private persistSession(socket: WebSocket, session: Session) {
    try { socket.serializeAttachment(session); } catch { /* the socket may be closing */ }
  }

  private broadcast(message: unknown, except?: WebSocket) {
    for (const [socket, session] of this.sessions) {
      if (socket === except || !session.authenticated || session.catchingUp) continue;
      this.send(socket, message);
    }
  }

  private reject(socket: WebSocket, code: string, message: string) {
    this.send(socket, { protocol, kind: "error", code, message });
    try { socket.close(1008, code); } catch { /* Ignore a socket already closed. */ }
  }

  private latestSequence() {
    const eventRow = this.ctx.storage.sql.exec<{ latest: number | null }>("SELECT MAX(sequence) AS latest FROM sync_events").toArray()[0];
    const checkpointRow = this.ctx.storage.sql.exec<{ latest: number | null }>("SELECT MAX(base_sequence) AS latest FROM sync_checkpoints WHERE complete = 1").toArray()[0];
    return Math.max(Number(eventRow?.latest ?? 0), Number(checkpointRow?.latest ?? 0));
  }

  private eventCount() {
    const row = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_events").toArray()[0];
    return Number(row?.count ?? 0);
  }

  private latestCheckpoint(): CheckpointRow | undefined {
    const row = this.ctx.storage.sql.exec<{ checkpoint_id: string; base_sequence: number; chunk_count: number }>(
      "SELECT checkpoint_id, base_sequence, chunk_count FROM sync_checkpoints WHERE complete = 1 ORDER BY base_sequence DESC LIMIT 1",
    ).toArray()[0];
    if (!row) return undefined;
    return { checkpointId: row.checkpoint_id, baseSequence: Number(row.base_sequence), chunkCount: Number(row.chunk_count) };
  }

  private firstRetainedSequence() {
    const row = this.ctx.storage.sql.exec<{ first: number | null }>("SELECT MIN(sequence) AS first FROM sync_events").toArray()[0];
    return row?.first === null || row?.first === undefined ? undefined : Number(row.first);
  }

  private readEventsAfter(sequence: number, limit: number) {
    return this.ctx.storage.sql.exec<{
      sequence: number;
      event_id: string;
      sender_device_id: string;
      created_at: string;
      encrypted: number;
      payload: string;
    }>(
      "SELECT sequence, event_id, sender_device_id, created_at, encrypted, payload FROM sync_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
      sequence,
      limit,
    ).toArray().map((row) => ({
      sequence: Number(row.sequence),
      eventId: row.event_id,
      senderDeviceId: row.sender_device_id,
      createdAt: row.created_at,
      encrypted: Boolean(row.encrypted),
      payload: row.payload,
    } satisfies StoredSyncEvent));
  }

  private sendCheckpoint(socket: WebSocket, session: Session, checkpoint: CheckpointRow) {
    const parts = this.ctx.storage.sql.exec<{ chunk_index: number; payload: string }>(
      "SELECT chunk_index, payload FROM sync_checkpoint_parts WHERE checkpoint_id = ? ORDER BY chunk_index ASC",
      checkpoint.checkpointId,
    ).toArray();
    if (parts.length !== checkpoint.chunkCount) {
      this.reject(socket, "checkpoint_incomplete", "Stored checkpoint is incomplete");
      return;
    }
    session.pendingCheckpointId = checkpoint.checkpointId;
    session.pendingCheckpointBase = checkpoint.baseSequence;
    this.persistSession(socket, session);
    this.send(socket, {
      protocol,
      kind: "checkpoint_start",
      checkpointId: checkpoint.checkpointId,
      baseSequence: checkpoint.baseSequence,
      chunkCount: checkpoint.chunkCount,
    });
    for (const part of parts) {
      this.send(socket, { protocol, kind: "checkpoint_chunk", checkpointId: checkpoint.checkpointId, chunkIndex: Number(part.chunk_index), data: part.payload });
    }
    this.send(socket, { protocol, kind: "checkpoint_complete", checkpointId: checkpoint.checkpointId, baseSequence: checkpoint.baseSequence });
  }

  private sendNextCatchupPage(socket: WebSocket, session: Session) {
    const events = this.readEventsAfter(session.lastAppliedSequence, catchupPageSize);
    if (events.length) {
      session.pendingCatchupThrough = events[events.length - 1].sequence;
      this.persistSession(socket, session);
      this.send(socket, { protocol, kind: "catchup", events });
      return;
    }
    session.catchingUp = false;
    session.pendingCatchupThrough = undefined;
    this.persistSession(socket, session);
    this.send(socket, { protocol, kind: "catchup_complete", latestSequence: this.latestSequence() });
  }

  private startCatchup(socket: WebSocket, session: Session, requestedSequence: number) {
    const latest = this.latestSequence();
    session.lastAppliedSequence = Math.min(requestedSequence, latest);
    session.catchingUp = true;
    session.pendingCatchupThrough = undefined;
    session.pendingCheckpointId = undefined;
    session.pendingCheckpointBase = undefined;
    this.persistSession(socket, session);

    const checkpoint = this.latestCheckpoint();
    const firstRetained = this.firstRetainedSequence();
    const historyGap = firstRetained === undefined
      ? Boolean(checkpoint && session.lastAppliedSequence < checkpoint.baseSequence)
      : session.lastAppliedSequence < firstRetained - 1;
    if (historyGap) {
      if (!checkpoint || checkpoint.baseSequence <= session.lastAppliedSequence) {
        this.reject(socket, "history_unavailable", "同步历史已被清理，且没有可用快照");
        return;
      }
      this.sendCheckpoint(socket, session, checkpoint);
      return;
    }
    this.sendNextCatchupPage(socket, session);
  }

  private persistEvents(events: PublishEvent[]) {
    return this.ctx.storage.transactionSync(() => {
      const accepted: Array<{ eventId: string; sequence: number }> = [];
      const inserted: StoredSyncEvent[] = [];
      const rejected: string[] = [];
      for (const event of events) {
        const existing = this.ctx.storage.sql.exec<{
          sequence: number;
          event_id: string;
          sender_device_id: string;
          created_at: string;
          encrypted: number;
          payload: string;
        }>(
          "SELECT sequence, event_id, sender_device_id, created_at, encrypted, payload FROM sync_events WHERE event_id = ? LIMIT 1",
          event.eventId,
        ).toArray()[0];
        if (existing) {
          const same = existing.sender_device_id === event.senderDeviceId
            && existing.created_at === event.createdAt
            && Boolean(existing.encrypted) === event.encrypted
            && existing.payload === event.payload;
          if (same) accepted.push({ eventId: event.eventId, sequence: Number(existing.sequence) });
          else rejected.push(event.eventId);
          continue;
        }
        this.ctx.storage.sql.exec(
          "INSERT INTO sync_events (event_id, sender_device_id, created_at, encrypted, payload) VALUES (?, ?, ?, ?, ?)",
          event.eventId,
          event.senderDeviceId,
          event.createdAt,
          event.encrypted ? 1 : 0,
          event.payload,
        );
        const insertedRow = this.ctx.storage.sql.exec<{ sequence: number }>("SELECT sequence FROM sync_events WHERE event_id = ?", event.eventId).toArray()[0];
        if (!insertedRow) throw new Error("event sequence missing after insert");
        const stored = { ...event, sequence: Number(insertedRow.sequence) } satisfies StoredSyncEvent;
        accepted.push({ eventId: event.eventId, sequence: stored.sequence });
        inserted.push(stored);
      }
      return { accepted, inserted, rejected };
    });
  }

  private async maybeRequestCheckpoint() {
    if (this.checkpointRequestInFlight) return;
    const count = this.eventCount();
    const latest = this.latestCheckpoint();
    if (count < 1_000 || (latest && this.latestSequence() - latest.baseSequence < 1_000)) return;
    const candidate = Array.from(this.sessions.entries()).find(([, session]) => session.authenticated && !session.catchingUp);
    if (!candidate) return;
    const [socket] = candidate;
    const requestId = crypto.randomUUID();
    this.checkpointRequestInFlight = requestId;
    this.send(socket, { protocol, kind: "checkpoint_request", requestId, targetSequence: this.latestSequence() });
    await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }

  async alarm() {
    this.ctx.storage.sql.exec("DELETE FROM sync_checkpoint_parts WHERE checkpoint_id IN (SELECT checkpoint_id FROM sync_checkpoints WHERE complete = 0 AND created_at < ?)", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    this.ctx.storage.sql.exec("DELETE FROM sync_checkpoints WHERE complete = 0 AND created_at < ?", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    this.checkpointRequestInFlight = undefined;
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
      session.lastAppliedSequence = message.lastAppliedSequence;
      socket.serializeAttachment(session);
      const peers = Array.from(this.sessions.values()).filter((peer) => peer.authenticated && peer.deviceId !== session.deviceId).map(peerFor);
      const latestSequence = this.latestSequence();
      const needsSnapshot = this.eventCount() === 0 && !this.latestCheckpoint();
      this.send(socket, { protocol, kind: "welcome", peers, latestSequence, needsSnapshot });
      this.startCatchup(socket, session, message.lastAppliedSequence);
      this.broadcast({ protocol, kind: "peer_joined", peer: peerFor(session) }, socket);
      return;
    }

    if (isCatchupRequest(message)) {
      this.startCatchup(socket, session, message.lastAppliedSequence);
      return;
    }

    if (isCatchupAck(message)) {
      if (!session.catchingUp || session.pendingCatchupThrough !== message.lastAppliedSequence) {
        this.reject(socket, "invalid_catchup_ack", "Catch-up acknowledgement is out of order");
        return;
      }
      session.lastAppliedSequence = message.lastAppliedSequence;
      session.pendingCatchupThrough = undefined;
      this.persistSession(socket, session);
      this.sendNextCatchupPage(socket, session);
      return;
    }

    if (isCheckpointAck(message)) {
      if (session.pendingCheckpointId !== message.checkpointId || session.pendingCheckpointBase !== message.baseSequence) {
        this.reject(socket, "invalid_checkpoint_ack", "Checkpoint acknowledgement is out of order");
        return;
      }
      session.lastAppliedSequence = message.baseSequence;
      session.pendingCheckpointId = undefined;
      session.pendingCheckpointBase = undefined;
      this.persistSession(socket, session);
      this.sendNextCatchupPage(socket, session);
      return;
    }

    if (isPublish(message)) {
      if (message.events.some((event) => event.senderDeviceId !== session.deviceId)) {
        this.reject(socket, "invalid_sender", "Event sender does not match the authenticated device");
        return;
      }
      try {
        const result = this.persistEvents(message.events);
        this.send(socket, { protocol, kind: "publish_ack", requestId: message.requestId, accepted: result.accepted, latestSequence: this.latestSequence() });
        if (result.rejected.length) {
          this.send(socket, { protocol, kind: "error", code: "event_id_collision", message: `Event id collision: ${result.rejected.join(",")}` });
        }
        if (result.inserted.length) {
          this.broadcast({ protocol, kind: "events", from: peerFor(session), events: result.inserted }, socket);
          await this.maybeRequestCheckpoint();
        }
      } catch {
        this.reject(socket, "storage_failed", "Unable to persist sync events");
      }
      return;
    }

    if (isPresence(message)) {
      session.label = cleanLabel(message.label);
      this.persistSession(socket, session);
      this.broadcast({ protocol, kind: "peer_joined", peer: peerFor(session) }, socket);
      return;
    }

    if (isCheckpointStart(message)) {
      const latest = this.latestSequence();
      if (message.baseSequence > latest || this.eventCount() < 1) {
        this.reject(socket, "invalid_checkpoint", "Checkpoint base sequence is not available");
        return;
      }
      const current = this.latestCheckpoint();
      if (current && message.baseSequence < current.baseSequence) {
        this.reject(socket, "stale_checkpoint", "Checkpoint is older than the stored checkpoint");
        return;
      }
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM sync_checkpoint_parts WHERE checkpoint_id = ?", message.checkpointId);
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO sync_checkpoints (checkpoint_id, base_sequence, chunk_count, created_at, complete) VALUES (?, ?, ?, ?, 0)", message.checkpointId, message.baseSequence, message.chunkCount, new Date().toISOString());
      });
      this.checkpointRequestInFlight = undefined;
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
      return;
    }

    if (isCheckpointChunk(message)) {
      const row = this.ctx.storage.sql.exec<{ checkpoint_id: string }>("SELECT checkpoint_id FROM sync_checkpoints WHERE checkpoint_id = ? AND complete = 0", message.checkpointId).toArray()[0];
      if (!row) {
        this.reject(socket, "invalid_checkpoint", "Checkpoint upload has not started");
        return;
      }
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO sync_checkpoint_parts (checkpoint_id, chunk_index, payload) VALUES (?, ?, ?)", message.checkpointId, message.chunkIndex, message.data);
      return;
    }

    if (isCheckpointComplete(message)) {
      const row = this.ctx.storage.sql.exec<{ base_sequence: number; chunk_count: number; complete: number }>("SELECT base_sequence, chunk_count, complete FROM sync_checkpoints WHERE checkpoint_id = ?", message.checkpointId).toArray()[0];
      if (!row || Boolean(row.complete) || Number(row.base_sequence) !== message.baseSequence) {
        this.reject(socket, "invalid_checkpoint", "Checkpoint upload is invalid");
        return;
      }
      const partCount = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_checkpoint_parts WHERE checkpoint_id = ?", message.checkpointId).toArray()[0];
      if (Number(partCount?.count ?? 0) !== Number(row.chunk_count)) {
        this.reject(socket, "incomplete_checkpoint", "Checkpoint chunks are incomplete");
        return;
      }
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE sync_checkpoints SET complete = 1 WHERE checkpoint_id = ?", message.checkpointId);
        this.ctx.storage.sql.exec("DELETE FROM sync_events WHERE sequence <= ?", message.baseSequence);
        this.ctx.storage.sql.exec("DELETE FROM sync_checkpoint_parts WHERE checkpoint_id IN (SELECT checkpoint_id FROM sync_checkpoints WHERE complete = 1 AND base_sequence < ?)", message.baseSequence);
        this.ctx.storage.sql.exec("DELETE FROM sync_checkpoints WHERE complete = 1 AND base_sequence < ?", message.baseSequence);
      });
      this.send(socket, { protocol, kind: "checkpoint_stored", checkpointId: message.checkpointId, baseSequence: message.baseSequence });
      return;
    }

    this.reject(socket, "invalid_message", "Invalid sync message");
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
