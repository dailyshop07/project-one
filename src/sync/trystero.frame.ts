import { joinRoom as joinMqttRoom } from "@trystero-p2p/mqtt";
import { joinRoom as joinNostrRoom } from "@trystero-p2p/nostr";

type Room = ReturnType<typeof joinMqttRoom>;

const relayUrls = [
  "wss://test.mosquitto.org:8081/mqtt",
  "wss://broker.emqx.io:8084/mqtt",
  "wss://public:public@public.cloud.shiftr.io",
  "wss://broker-cn.emqx.io:8084/mqtt",
];

type Strategy = "mqtt" | "nostr";
type StartMessage = { type: "start"; strategy: Strategy; roomId: string; password: string; iceServers?: RTCIceServer[] };
type RequestMessage =
  | { type: "send"; requestId: number; namespace: string; data: unknown; target?: string | string[] | null }
  | { type: "ping"; requestId: number; peerId: string }
  | { type: "closePeer"; peerId: string }
  | { type: "leave"; requestId: number };
type IncomingMessage = StartMessage | RequestMessage;
type TrysteroMessageAction = {
  send: (data: unknown, options?: { target?: string | string[] | null }) => Promise<void>;
  onMessage: ((data: unknown, context: { peerId: string }) => void | Promise<void>) | null;
};

const actions = new Map<string, TrysteroMessageAction>();
let room: Room | undefined;
let port: MessagePort | undefined;

const post = (message: unknown) => port?.postMessage(message);
const respond = (requestId: number, value?: unknown, error?: unknown) => post({
  type: "response",
  requestId,
  value,
  ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
});

const getAction = (namespace: string) => {
  if (!room) throw new Error("connection room is not ready");
  const existing = actions.get(namespace);
  if (existing) return existing;
  const action = room.makeAction(namespace) as unknown as TrysteroMessageAction;
  action.onMessage = (data: unknown, context: { peerId: string }) => post({ type: "action", namespace, data, peerId: context.peerId });
  actions.set(namespace, action);
  return action;
};

const handleMessage = async (message: IncomingMessage) => {
  if (message.type === "start") {
    const joinRoom = message.strategy === "mqtt" ? joinMqttRoom : joinNostrRoom;
    room = joinRoom(
      {
        appId: "project-one-p2p-v2",
        password: message.password,
        ...(message.iceServers?.length ? { rtcConfig: { iceServers: message.iceServers } } : {}),
        ...(message.strategy === "mqtt" ? { relayConfig: { urls: relayUrls, warnOnRelayFailure: false } } : {}),
      },
      message.roomId,
      {
        onJoinError: ({ error }) => post({ type: "joinError", error }),
      },
    );
    ["hello", "operations", "acks", "sync"].forEach(getAction);
    room.onPeerJoin = (peerId) => post({ type: "peerJoin", peerId });
    room.onPeerLeave = (peerId) => post({ type: "peerLeave", peerId });
    return;
  }
  try {
    if (message.type === "send") {
      await getAction(message.namespace).send(message.data, { target: message.target });
      respond(message.requestId);
    } else if (message.type === "ping") {
      respond(message.requestId, await room?.ping(message.peerId));
    } else if (message.type === "closePeer") {
      room?.getPeers()[message.peerId]?.close();
    } else if (message.type === "leave") {
      await room?.leave();
      room = undefined;
      actions.clear();
      respond(message.requestId);
    }
  } catch (error) {
    if ("requestId" in message) respond(message.requestId, undefined, error);
  }
};

window.addEventListener("message", (event: MessageEvent<{ type?: string }>) => {
  if (event.origin !== window.location.origin || event.data?.type !== "attach" || !event.ports[0] || port) return;
  port = event.ports[0];
  port.onmessage = (portEvent: MessageEvent<IncomingMessage>) => void handleMessage(portEvent.data);
  port.start();
  post({ type: "ready" });
});
