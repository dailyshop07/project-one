# Project One Cloudflare sync relay

This Worker is only a real-time relay. Each `roomId` maps to one Durable Object instance, and the Durable Object keeps only live WebSocket session metadata in memory/serialized WebSocket attachments. Product, inventory, sales, reports, and the IndexedDB outbox never become Cloudflare database records.

The browser connects to:

```text
wss://<worker-host>/ws/<sha256-base64url("project-one-room:" + pairing-secret)>
```

The pairing secret is sent only in the first authenticated WebSocket message over TLS. The Worker verifies that it hashes to the room path before it accepts the device. A wrong secret cannot join another room. The browser continues to use its existing pairing secret and IndexedDB schema.

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

## Login and deployment

Use a browser-based Wrangler login; do not put a Cloudflare token in this repository:

```bash
npx wrangler login
npx wrangler deploy
```

If `npx` is not installed on the machine, the equivalent is `pnpm exec wrangler login` and `pnpm exec wrangler deploy` after installing dependencies. The deploy command prints the Worker URL. Set that URL as the non-secret GitHub Actions repository variable `CLOUDFLARE_SYNC_URL`, or pass it as `VITE_CLOUDFLARE_SYNC_URL` when building Pages.

The Worker URL is public routing information. The pairing secret, Cloudflare token, and any other credentials must remain outside Git and outside the public Vite bundle.
