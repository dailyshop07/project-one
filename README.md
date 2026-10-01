# Project One

Project One is an iPhone-first, local-first PWA for daily records, quick sales, products, inventory, history, and lightweight analysis.

## Privacy and storage

- All user-created records live in IndexedDB on the device.
- GitHub Pages serves only the compiled application shell and static assets.
- No account, cloud database, analytics, or telemetry is used.
- Pairing secrets and device identifiers are generated at runtime and are never part of the repository.
- Trystero/WebRTC is used only to exchange queued operations between paired devices. It is not the database.
- Public Nostr and MQTT endpoints carry only encrypted WebRTC discovery/signaling messages. Business records travel over the resulting encrypted WebRTC data channels (or encrypted TURN when configured), never through the public signaling topics.
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

`pnpm test:p2p` runs the live two-peer lifecycle probe against both signaling paths. It verifies a WebRTC ping and application payload round trip for cold start, delayed start, 0/10/30/60-second background recovery, both-peer recovery, and five repeated recovery cycles.

## P2P lifecycle

The UI, React state, and IndexedDB database stay in the main page. Trystero, signaling sockets, and `RTCPeerConnection` instances live in replaceable same-origin transport frames. Going to the background discards only those frames. Returning to the foreground creates new Window realms and therefore new Trystero peer identities, avoiding reuse of Safari-suspended connections while preserving the user's current page and all local data.

Nostr and MQTT discovery run independently. Either path can establish the WebRTC channel, so a slow or unavailable public relay network does not become a single point of failure. An unanswered discovery generation is replaced automatically; no refresh or reconnect button is required.

## GitHub Pages

The included Pages workflow builds and deploys `dist/`. In the repository settings, select **GitHub Actions** as the Pages source. No runtime secrets or environment variables are required.

## Mobile-network connectivity

Direct WebRTC can fail when one phone is on 4G/5G and the other is behind a Wi-Fi router. For reliable cross-network connections, deploy a backend endpoint that returns short-lived TURN credentials and set `VITE_TURN_CREDENTIALS_URL` during the Pages build. The expected response is the standard `{ "iceServers": [...] }` shape returned by providers such as Cloudflare Realtime TURN.

Do not put a TURN API token or long-lived TURN password in a `VITE_*` variable: Vite embeds those values in the public browser bundle. The credential endpoint must keep the provider secret server-side and return only expiring client credentials.

## First iPhone

1. Open the deployed HTTPS link in Safari once.
2. Use Share → Add to Home Screen.
3. Open Project One from the Home Screen.
4. Add products from the Products tab. No sample business data is shipped.
5. Export a local backup from Settings after entering initial data.

If a Home Screen icon was created before an invite was scanned, delete that old icon and add it again from the invitation page so iOS can copy the one-time pairing handoff.

To connect a second iPhone, open Settings and choose **Show invitation QR code**, then scan it with the other phone's camera. You can also send or copy the private invitation link from the same screen. Both apps must be open at the same time for WebRTC to exchange queued operations.
