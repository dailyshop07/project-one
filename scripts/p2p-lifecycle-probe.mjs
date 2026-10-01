import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const strategies = ["nostr", "mqtt"];
const relayUrls = [
  "wss://test.mosquitto.org:8081/mqtt",
  "wss://broker.emqx.io:8084/mqtt",
  "wss://public:public@public.cloud.shiftr.io",
  "wss://broker-cn.emqx.io:8084/mqtt",
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

if (process.argv.includes("--worker")) {
  const role = process.argv.at(-2);
  const strategy = process.argv.at(-1);
  const trystero = strategy === "mqtt"
    ? await import("@trystero-p2p/mqtt")
    : await import("@trystero-p2p/nostr");
  const { RTCPeerConnection } = await import("werift");
  const roomId = process.env.PROBE_ROOM_ID;
  const password = process.env.PROBE_PASSWORD;
  let room;
  let joinedAt = 0;
  let generation = 0;
  const payloadWaiters = new Map();

  const report = (event, details = {}) => process.send?.({ role, strategy, event, generation, at: Date.now(), ...details });

  const leave = async () => {
    const previous = room;
    room = undefined;
    if (!previous) return;
    previous.onPeerJoin = null;
    previous.onPeerLeave = null;
    for (const peer of Object.values(previous.getPeers())) peer.close();
    await Promise.race([previous.leave().catch(() => undefined), sleep(2_000)]);
  };

  const join = () => {
    generation += 1;
    joinedAt = Date.now();
    const current = trystero.joinRoom(
      {
        appId: "project-one-p2p-lifecycle-probe",
        password,
        rtcPolyfill: RTCPeerConnection,
        ...(strategy === "mqtt" ? { relayConfig: { urls: relayUrls, warnOnRelayFailure: false } } : {}),
      },
      roomId,
    );
    room = current;
    const probeAction = current.makeAction("probe");
    probeAction.onMessage = async (data, context) => {
      if (data?.type === "probe") {
        await probeAction.send({ type: "probeReply", nonce: data.nonce }, { target: context.peerId });
      } else if (data?.type === "probeReply") {
        payloadWaiters.get(data.nonce)?.();
        payloadWaiters.delete(data.nonce);
      }
    };
    current.onPeerJoin = async (peerId) => {
      if (room !== current) return;
      try {
        const pingMs = await Promise.race([
          current.ping(peerId),
          sleep(3_000).then(() => { throw new Error("ping timeout"); }),
        ]);
        const nonce = crypto.randomUUID();
        const payloadRoundTrip = new Promise((resolve) => payloadWaiters.set(nonce, resolve));
        await probeAction.send({ type: "probe", nonce }, { target: peerId });
        await Promise.race([
          payloadRoundTrip,
          sleep(3_000).then(() => { throw new Error("payload timeout"); }),
        ]);
        report("connected", { connectMs: Date.now() - joinedAt, pingMs, payloadVerified: true });
      } catch (error) {
        report("peer-error", { message: error instanceof Error ? error.message : String(error) });
      }
    };
    current.onPeerLeave = () => report("peer-left");
    report("joined");
  };

  process.on("message", async (message) => {
    try {
      if (message === "join") join();
      if (message === "background") {
        for (const peer of Object.values(room?.getPeers() ?? {})) peer.close();
        report("backgrounded");
      }
      if (message === "stop") {
        await leave();
        process.exit(0);
      }
    } catch (error) {
      report("worker-error", { message: error instanceof Error ? error.stack : String(error) });
    }
  });
  report("worker-ready");
} else {
  const scriptPath = fileURLToPath(import.meta.url);
  const roomId = `probe-${crypto.randomUUID()}`;
  const password = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const children = new Map();
  const messages = [];
  let sequence = 0;

  const transportId = (role, strategy) => `${role}-${strategy}`;
  const spawnTransport = (role, strategy) => {
    const id = transportId(role, strategy);
    const child = fork(scriptPath, ["--worker", role, strategy], {
      env: { ...process.env, PROBE_ROOM_ID: roomId, PROBE_PASSWORD: password },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    children.set(id, child);
    child.on("message", (message) => messages.push({ ...message, id, sequence: ++sequence }));
    return child;
  };

  const checkpoint = () => sequence;
  const waitFor = (id, event, after = 0, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const match = messages.find((message) => message.sequence > after && message.id === id && message.event === event);
      if (match) return resolve(match);
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${id}:${event}`));
      setTimeout(poll, 25);
    };
    poll();
  });

  const send = (id, command) => children.get(id)?.send(command);
  const startDevice = async (role, after = checkpoint()) => {
    strategies.forEach((strategy) => spawnTransport(role, strategy));
    await Promise.all(strategies.map((strategy) => waitFor(transportId(role, strategy), "worker-ready", after)));
    strategies.forEach((strategy) => send(transportId(role, strategy), "join"));
  };
  const terminateDevice = async (role) => {
    await Promise.all(strategies.map(async (strategy) => {
      const id = transportId(role, strategy);
      const child = children.get(id);
      if (!child) return;
      const after = checkpoint();
      send(id, "background");
      await waitFor(id, "backgrounded", after);
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      children.delete(id);
    }));
  };
  const waitForWinningPath = (after, startedAt, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      for (const strategy of strategies) {
        const a = messages.find((message) => message.sequence > after && message.id === transportId("A", strategy) && message.event === "connected");
        const b = messages.find((message) => message.sequence > after && message.id === transportId("B", strategy) && message.event === "connected");
        if (a && b) {
          return resolve({
            elapsedMs: Date.now() - startedAt,
            strategy,
            peerConnectMs: { A: a.connectMs, B: b.connectMs },
            pingMs: { A: a.pingMs, B: b.pingMs },
            payloadVerified: a.payloadVerified === true && b.payloadVerified === true,
          });
        }
      }
      if (Date.now() >= deadline) {
        const recent = messages.filter((message) => message.sequence > after);
        return reject(new Error(`no signaling path connected both peers; events=${JSON.stringify(recent)}`));
      }
      setTimeout(poll, 25);
    };
    poll();
  });
  const record = (scenario, result) => {
    const line = { scenario, ...result };
    console.log(JSON.stringify(line));
    return line;
  };

  const results = [];
  try {
    strategies.forEach((strategy) => {
      spawnTransport("A", strategy);
      spawnTransport("B", strategy);
    });
    await Promise.all(["A", "B"].flatMap((role) => strategies.map((strategy) => waitFor(transportId(role, strategy), "worker-ready"))));

    let after = checkpoint();
    let startedAt = Date.now();
    for (const role of ["A", "B"]) for (const strategy of strategies) send(transportId(role, strategy), "join");
    results.push(record("simultaneous-cold-start", await waitForWinningPath(after, startedAt)));

    await terminateDevice("B");
    await sleep(1_000);
    after = checkpoint();
    startedAt = Date.now();
    await startDevice("B", after);
    results.push(record("A-online-B-cold-start", await waitForWinningPath(after, startedAt)));

    for (const backgroundMs of [0, 10_000, 30_000, 60_000]) {
      await terminateDevice("A");
      await sleep(backgroundMs);
      after = checkpoint();
      startedAt = Date.now();
      await startDevice("A", after);
      results.push(record(`A-background-${backgroundMs / 1_000}s`, await waitForWinningPath(after, startedAt)));
    }

    await Promise.all([terminateDevice("A"), terminateDevice("B")]);
    await sleep(2_000);
    await startDevice("A");
    await sleep(2_000);
    after = checkpoint();
    startedAt = Date.now();
    await startDevice("B", after);
    results.push(record("both-background-return-sequentially", await waitForWinningPath(after, startedAt)));

    for (let cycle = 1; cycle <= 5; cycle += 1) {
      await terminateDevice("B");
      await sleep(1_000);
      after = checkpoint();
      startedAt = Date.now();
      await startDevice("B", after);
      results.push(record(`B-repeated-cycle-${cycle}`, await waitForWinningPath(after, startedAt)));
    }

    const elapsedValues = results.map((result) => result.elapsedMs);
    console.log(JSON.stringify({ summary: {
      scenarios: results.length,
      maxMs: Math.max(...elapsedValues),
      averageMs: Math.round(elapsedValues.reduce((sum, value) => sum + value, 0) / elapsedValues.length),
      payloadVerified: results.every((result) => result.payloadVerified),
    } }));
  } finally {
    for (const child of children.values()) child.send("stop");
    await sleep(500);
    for (const child of children.values()) if (!child.killed) child.kill();
  }
}
