# Project One Cloudflare durable sync

This directory contains the isolated server side of Project One's sync adapter. It uses a Cloudflare Worker, a Durable Object per pairing room, SQLite Storage, and the Durable Objects WebSocket Hibernation API.

The Durable Object is not the primary business database. The browser commits business changes to IndexedDB first. The Worker stores only the encrypted sync event log/checkpoints needed for store-and-forward delivery:

- every event has a globally unique `eventId` and a room-local monotonic `sequence`;
- the server transactionally inserts a new event or returns the existing sequence for a retry;
- the client keeps `lastAppliedSequence` and sends it during every connection handshake;
- the server sends paged catch-up events before live WebSocket events;
- the client acknowledges an outbox event only after the server returns `publish_ack`;
- the client applies each event through the existing Repository, which preserves business merge/conflict logic and local idempotency;
- a caught-up client can upload an encrypted checkpoint, after which the Durable Object compacts covered events while retaining the newest checkpoint.

Payload encryption is performed in the browser with AES-GCM using a key derived from the pairing secret. The Worker does not decrypt normal business records. It sees room routing metadata and ciphertext only.

The browser connects to:

```text
wss://<worker-host>/ws/<sha256-base64url("project-one-room:" + pairing-secret)>
```

The pairing secret is sent only in the first authenticated WebSocket message over TLS. The Worker verifies that it hashes to the room path before accepting the device. A wrong secret cannot join another room. Pairing secrets, Cloudflare tokens, and business data must never be committed to this repository.

## Local development

From this directory:

```bash
pnpm install
pnpm run types
pnpm run dev
```

The local Worker endpoint can be supplied to the Vite app as:

```bash
VITE_CLOUDFLARE_SYNC_URL=http://127.0.0.1:8787 pnpm --dir .. dev
```

`workerd` may require a newer macOS or a Linux DevContainer. The production endpoint is still suitable for end-to-end WebSocket testing if the local runtime cannot start.

## Login and deployment

Use a browser-based Wrangler login; do not put a Cloudflare token in this repository:

```bash
npx wrangler login
npx wrangler deploy
```

If `npx` is not installed on the machine, the equivalent is `pnpm exec wrangler login` and `pnpm exec wrangler deploy` after installing dependencies. The deploy command prints the Worker URL. Set that URL as the non-secret GitHub Actions repository variable `CLOUDFLARE_SYNC_URL`, or pass it as `VITE_CLOUDFLARE_SYNC_URL` when building Pages.

The current deployed endpoint is:

```text
https://project-one-sync.project-one-cloudflare-sync.workers.dev
```
