# Project One

Project One is an iPhone-first, local-first PWA for daily records, quick sales, products, inventory, history, and lightweight analysis.

## Privacy and storage

- All user-created records live in IndexedDB on the device.
- GitHub Pages serves only the compiled application shell and static assets.
- No account, cloud database, analytics, or telemetry is used.
- Pairing secrets and device identifiers are generated at runtime and are never part of the repository.
- Cloudflare Workers + Durable Objects + WebSocket provide the sync transport and a durable, encrypted room event log. IndexedDB is still the primary business database; Cloudflare stores opaque sync events/checkpoints only so an offline device can catch up later.
- On iOS, Safari and a standalone Home Screen Web App have separate storage. The invite flow uses a short-lived first-party cookie for the install handoff, and every newly discovered peer receives an idempotent full data snapshot before incremental operations continue.
- After 20:00 local time, the app creates one automatic local backup per day when it is open or the next time it is opened. It keeps recent backup history on the device for recovery; export a JSON backup to Files for protection against clearing browser data or uninstalling the app.

## Local development

Requirements: Node.js 20.19 or newer and pnpm.

```bash
pnpm install
pnpm dev
pnpm test
pnpm build
```

The production build is written to `dist/` and uses relative asset paths, so it can run from a GitHub Pages repository subpath.

## GitHub Pages

The included Pages workflow builds and deploys `dist/`. In the repository settings, select **GitHub Actions** as the Pages source. No runtime secrets or environment variables are required.

## Cloudflare WebSocket sync

The independent adapter/backend lives in [`cloudflare-sync/`](./cloudflare-sync/). It uses the Durable Objects WebSocket Hibernation API and SQLite Storage. Each pairing secret maps to one opaque room ID. A local business change is committed to IndexedDB first, remains in the local pending outbox until the Worker acknowledges durable storage, and is then assigned a monotonically increasing room sequence. A device reconnects with its IndexedDB `lastAppliedSequence`; the Durable Object sends missing pages before allowing live events.

Event payloads and checkpoints are encrypted in the browser with an AES-GCM key derived from the pairing secret. The Worker routes and stores ciphertext, not the normal business records. Each event also has a unique `eventId`, and both the server log and local `processedOperations` table make retries idempotent.

The event log is retained until a caught-up device uploads an encrypted checkpoint. The Durable Object then compacts events covered by that checkpoint while retaining the latest checkpoint, so a device that has been offline for a long time can still recover without requiring another pairing.

Install and deploy the relay from that directory with a browser OAuth flow. Never put a Cloudflare token, pairing secret or business data in Git:

```bash
cd cloudflare-sync
pnpm install
npx wrangler login
npx wrangler deploy
```

The Pages workflow already defaults to the deployed public Worker URL; you can override it with the non-secret GitHub Actions repository variable `CLOUDFLARE_SYNC_URL` (or use `VITE_CLOUDFLARE_SYNC_URL` locally). The Pages build injects only this routing URL. If it is not configured, Project One remains local-only and IndexedDB continues to work.

## First iPhone

1. Open the deployed HTTPS link in Safari once.
2. Use Share → Add to Home Screen.
3. Open Project One from the Home Screen.
4. Add products from the Products tab. No sample business data is shipped.
5. Export a local backup from Settings after entering initial data.

If a Home Screen icon was created before an invite was scanned, delete that old icon and add it again from the invitation page so iOS can copy the one-time pairing handoff.

To connect a second iPhone, open Settings and choose **Show invitation QR code**, then scan it with the other phone's camera. You can also send or copy the private invitation link from the same screen. The first device can be opened before the second; the relay keeps the room available and the second device is discovered immediately after it authenticates. No daily re-pairing is required.
