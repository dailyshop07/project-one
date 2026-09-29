const credentialEndpoint = import.meta.env.VITE_TURN_CREDENTIALS_URL?.trim();

const validIceServer = (value: unknown): value is RTCIceServer => {
  if (!value || typeof value !== "object") return false;
  const server = value as Partial<RTCIceServer>;
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.length > 0 && urls.every((url) => typeof url === "string" && /^(stun|turn|turns):/i.test(url));
};

/**
 * Fetch short-lived TURN credentials from a trusted backend. Long-lived TURN
 * secrets must never be embedded in this static PWA because anyone could copy
 * and abuse them from the downloaded JavaScript bundle.
 */
export async function fetchTurnIceServers(): Promise<RTCIceServer[] | undefined> {
  if (!credentialEndpoint) return undefined;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 2_500);
  try {
    const response = await fetch(credentialEndpoint, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TURN credential endpoint returned ${response.status}`);
    const payload = await response.json() as { iceServers?: unknown };
    if (!Array.isArray(payload.iceServers)) throw new Error("TURN credential response is missing iceServers");
    const iceServers = payload.iceServers.filter(validIceServer);
    if (!iceServers.some((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url)))) {
      throw new Error("TURN credential response has no TURN server");
    }
    return iceServers;
  } catch (error) {
    console.warn("TURN credentials are unavailable; direct WebRTC will be used", error);
    return undefined;
  } finally {
    window.clearTimeout(timer);
  }
}
