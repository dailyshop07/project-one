import { afterEach, describe, expect, it, vi } from "vitest";

import { createTrysteroFrameRoom } from "./trysteroFrameRoom";

describe("isolated multi-strategy transport frames", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates independent Window realms, prefixes peers, routes actions, and removes both realms", async () => {
    const transports: Array<{ port: MessagePort; strategy?: string; messages: unknown[]; removed: boolean }> = [];
    const body = {
      append: (frame: any) => queueMicrotask(() => frame.listeners.load?.()),
    };
    const documentStub = {
      baseURI: "https://example.test/project-one/",
      body,
      documentElement: body,
      createElement: () => {
        const transport = { port: undefined as unknown as MessagePort, strategy: undefined as string | undefined, messages: [] as unknown[], removed: false };
        const frame = {
          style: {},
          listeners: {} as Record<string, () => void>,
          setAttribute: vi.fn(),
          addEventListener: (name: string, handler: () => void) => { frame.listeners[name] = handler; },
          remove: () => { transport.removed = true; },
          contentWindow: {
            postMessage: (_message: unknown, _origin: string, ports: MessagePort[]) => {
              transport.port = ports[0];
              transport.port.onmessage = (event) => {
                const message = event.data;
                transport.messages.push(message);
                if (message.type === "start") transport.strategy = message.strategy;
                if (typeof message.requestId === "number") transport.port.postMessage({ type: "response", requestId: message.requestId });
              };
              transport.port.start();
              transport.port.postMessage({ type: "ready" });
            },
          },
        };
        transports.push(transport);
        return frame;
      },
    };
    vi.stubGlobal("document", documentStub);
    vi.stubGlobal("window", { location: { origin: "https://example.test" } });

    const room = createTrysteroFrameRoom({ roomId: "room", password: "secret" });
    const joined: string[] = [];
    room.onPeerJoin = (peerId) => joined.push(peerId);

    await vi.waitFor(() => expect(transports.map((transport) => transport.strategy).sort()).toEqual(["mqtt", "nostr"]));
    const nostr = transports.find((transport) => transport.strategy === "nostr")!;
    const mqtt = transports.find((transport) => transport.strategy === "mqtt")!;
    nostr.port.postMessage({ type: "peerJoin", peerId: "n1" });
    mqtt.port.postMessage({ type: "peerJoin", peerId: "m1" });

    await vi.waitFor(() => expect(joined.sort()).toEqual(["mqtt:m1", "nostr:n1"]));
    expect(Object.keys(room.getPeers()).sort()).toEqual(["mqtt:m1", "nostr:n1"]);

    const action = room.makeAction("hello");
    await action.send({ hello: true }, { target: "nostr:n1" });
    await vi.waitFor(() => expect(nostr.messages.some((message: any) => message.type === "send" && message.target === "n1")).toBe(true));
    expect(mqtt.messages.some((message: any) => message.type === "send")).toBe(false);

    room.terminate();
    expect(transports.every((transport) => transport.removed)).toBe(true);
    expect(room.getPeers()).toEqual({});
  });
});
