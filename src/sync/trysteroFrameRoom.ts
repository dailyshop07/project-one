type FrameStartMessage = {
  type: "start";
  strategy: Strategy;
  roomId: string;
  password: string;
  iceServers?: RTCIceServer[];
};

type FrameRequestMessage =
  | { type: "send"; requestId: number; namespace: string; data: unknown; target?: string | string[] | null }
  | { type: "ping"; requestId: number; peerId: string }
  | { type: "closePeer"; peerId: string }
  | { type: "leave"; requestId: number };
type FrameRequestWithoutId =
  | { type: "send"; namespace: string; data: unknown; target?: string | string[] | null }
  | { type: "ping"; peerId: string }
  | { type: "leave" };

type FrameEventMessage =
  | { type: "ready" }
  | { type: "peerJoin"; peerId: string }
  | { type: "peerLeave"; peerId: string }
  | { type: "action"; namespace: string; data: unknown; peerId: string }
  | { type: "response"; requestId: number; value?: unknown; error?: string }
  | { type: "joinError"; error: string };

type FrameAction = {
  send: (data: unknown, options?: { target?: string | string[] | null }) => Promise<void>;
  onMessage: ((data: unknown, context: { peerId: string }) => void | Promise<void>) | null;
};

export interface ConnectionRoom {
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  makeAction<T = unknown>(namespace: string): FrameAction;
  getPeers(): Record<string, Pick<RTCPeerConnection, "close">>;
  ping(peerId: string): Promise<number>;
  leave(): Promise<void>;
  terminate(): void;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type Strategy = "mqtt" | "nostr";

const strategyOrder: Strategy[] = ["nostr", "mqtt"];

const splitPeerId = (peerId: string): [Strategy, string] => {
  const separator = peerId.indexOf(":");
  const strategy = peerId.slice(0, separator) as Strategy;
  return [strategy, peerId.slice(separator + 1)];
};

function createStrategyFrameRoom(
  config: { roomId: string; password: string; iceServers?: RTCIceServer[] },
  strategy: Strategy,
  callbacks?: { onJoinError?: (error: string) => void },
): ConnectionRoom {
  const frame = document.createElement("iframe");
  const frameUrl = new URL("p2p-transport.html", document.baseURI);
  frame.src = frameUrl.href;
  frame.title = "P2P transport";
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, {
    position: "fixed",
    width: "0",
    height: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
  });

  const channel = new MessageChannel();
  const port = channel.port1;
  const peers = new Map<string, Pick<RTCPeerConnection, "close">>();
  const actions = new Map<string, FrameAction>();
  const pending = new Map<number, PendingRequest>();
  let requestId = 0;
  let terminated = false;
  let ready = false;
  let onPeerJoin: ((peerId: string) => void) | null = null;
  let onPeerLeave: ((peerId: string) => void) | null = null;

  const rejectPending = (message: string) => {
    for (const request of pending.values()) request.reject(new Error(message));
    pending.clear();
  };

  const request = (message: FrameRequestWithoutId) => {
    if (terminated) return Promise.reject(new Error("connection frame terminated"));
    const id = ++requestId;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ ...message, requestId: id } as FrameRequestMessage);
    });
  };

  port.onmessage = (event: MessageEvent<FrameEventMessage>) => {
    const message = event.data;
    if (message.type === "ready") {
      if (ready || terminated) return;
      ready = true;
      port.postMessage({
        type: "start",
        strategy,
        roomId: config.roomId,
        password: config.password,
        iceServers: config.iceServers,
      } satisfies FrameStartMessage);
      return;
    }
    if (message.type === "response") {
      const waiting = pending.get(message.requestId);
      if (!waiting) return;
      pending.delete(message.requestId);
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message.value);
      return;
    }
    if (message.type === "joinError") {
      callbacks?.onJoinError?.(message.error);
      return;
    }
    if (message.type === "action") {
      void actions.get(message.namespace)?.onMessage?.(message.data, { peerId: message.peerId });
      return;
    }
    if (message.type === "peerJoin") {
      peers.set(message.peerId, {
        close: () => {
          if (!terminated) port.postMessage({ type: "closePeer", peerId: message.peerId } satisfies FrameRequestMessage);
        },
      });
      onPeerJoin?.(message.peerId);
      return;
    }
    peers.delete(message.peerId);
    onPeerLeave?.(message.peerId);
  };
  port.start();

  frame.addEventListener("load", () => {
    if (!terminated) frame.contentWindow?.postMessage({ type: "attach" }, window.location.origin, [channel.port2]);
  }, { once: true });
  frame.addEventListener("error", () => {
    callbacks?.onJoinError?.("connection frame failed to load");
    rejectPending("connection frame failed to load");
  }, { once: true });
  (document.body ?? document.documentElement).append(frame);

  return {
    makeAction: (namespace) => {
      const existing = actions.get(namespace);
      if (existing) return existing;
      const action: FrameAction = {
        send: (data, options) => request({ type: "send", namespace, data, target: options?.target }).then(() => undefined),
        onMessage: null,
      };
      actions.set(namespace, action);
      return action;
    },
    getPeers: () => Object.fromEntries(peers),
    ping: (peerId) => request({ type: "ping", peerId }).then((value) => Number(value)),
    leave: () => request({ type: "leave" }).then(() => undefined),
    terminate: () => {
      if (terminated) return;
      terminated = true;
      port.close();
      frame.remove();
      peers.clear();
      onPeerJoin = null;
      onPeerLeave = null;
      actions.forEach((action) => { action.onMessage = null; });
      rejectPending("connection frame terminated");
    },
    get onPeerJoin() {
      return onPeerJoin;
    },
    set onPeerJoin(handler) {
      onPeerJoin = handler;
      if (handler) peers.forEach((_, peerId) => handler(peerId));
    },
    get onPeerLeave() {
      return onPeerLeave;
    },
    set onPeerLeave(handler) {
      onPeerLeave = handler;
    },
  };
}

export function createTrysteroFrameRoom(
  config: { roomId: string; password: string; iceServers?: RTCIceServer[] },
  callbacks?: { onJoinError?: (error: string) => void },
): ConnectionRoom {
  const failedStrategies = new Set<Strategy>();
  const rooms = Object.fromEntries(strategyOrder.map((strategy) => [
    strategy,
    createStrategyFrameRoom(config, strategy, {
      onJoinError: (error) => {
        failedStrategies.add(strategy);
        if (failedStrategies.size === strategyOrder.length) callbacks?.onJoinError?.(error);
      },
    }),
  ])) as Record<Strategy, ConnectionRoom>;
  const peers = new Map<string, Pick<RTCPeerConnection, "close">>();
  const actions = new Map<string, FrameAction>();
  let terminated = false;
  let onPeerJoin: ((peerId: string) => void) | null = null;
  let onPeerLeave: ((peerId: string) => void) | null = null;

  strategyOrder.forEach((strategy) => {
    const room = rooms[strategy];
    room.onPeerJoin = (rawPeerId) => {
      const peerId = `${strategy}:${rawPeerId}`;
      peers.set(peerId, { close: () => room.getPeers()[rawPeerId]?.close() });
      onPeerJoin?.(peerId);
    };
    room.onPeerLeave = (rawPeerId) => {
      const peerId = `${strategy}:${rawPeerId}`;
      peers.delete(peerId);
      onPeerLeave?.(peerId);
    };
  });

  const targetsByStrategy = (target?: string | string[] | null) => {
    if (target == null) return strategyOrder.map((strategy) => ({ strategy, target }));
    const targets = Array.isArray(target) ? target : [target];
    return strategyOrder.flatMap((strategy) => {
      const matching = targets.filter((peerId) => peerId.startsWith(`${strategy}:`)).map((peerId) => splitPeerId(peerId)[1]);
      return matching.length ? [{ strategy, target: Array.isArray(target) ? matching : matching[0] }] : [];
    });
  };

  return {
    makeAction: (namespace) => {
      const existing = actions.get(namespace);
      if (existing) return existing;
      const underlying = Object.fromEntries(strategyOrder.map((strategy) => {
        const action = rooms[strategy].makeAction(namespace);
        action.onMessage = (data, context) => composite.onMessage?.(data, { peerId: `${strategy}:${context.peerId}` });
        return [strategy, action];
      })) as Record<Strategy, FrameAction>;
      const composite: FrameAction = {
        send: async (data, options) => {
          if (terminated) throw new Error("connection frame terminated");
          await Promise.all(targetsByStrategy(options?.target).map(({ strategy, target }) => underlying[strategy].send(data, { target })));
        },
        onMessage: null,
      };
      actions.set(namespace, composite);
      return composite;
    },
    getPeers: () => Object.fromEntries(peers),
    ping: (peerId) => {
      const [strategy, rawPeerId] = splitPeerId(peerId);
      return rooms[strategy].ping(rawPeerId);
    },
    leave: async () => {
      await Promise.allSettled(strategyOrder.map((strategy) => rooms[strategy].leave()));
    },
    terminate: () => {
      if (terminated) return;
      terminated = true;
      strategyOrder.forEach((strategy) => rooms[strategy].terminate());
      peers.clear();
      onPeerJoin = null;
      onPeerLeave = null;
      actions.forEach((action) => { action.onMessage = null; });
    },
    get onPeerJoin() {
      return onPeerJoin;
    },
    set onPeerJoin(handler) {
      onPeerJoin = handler;
      if (handler) peers.forEach((_, peerId) => handler(peerId));
    },
    get onPeerLeave() {
      return onPeerLeave;
    },
    set onPeerLeave(handler) {
      onPeerLeave = handler;
    },
  };
}
