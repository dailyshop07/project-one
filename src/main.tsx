import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import "./styles.css";

const resumeReloadParam = "_po_resume";
const signalledBackgroundThresholdMs = 300;
const missedHeartbeatThresholdMs = 2_500;
const foregroundHeartbeatIntervalMs = 250;

// Remove the one-use cache-busting marker before App reads an invitation URL.
// Other query parameters, including the private pairing handoff, are preserved.
const initialUrl = new URL(window.location.href);
if (initialUrl.searchParams.has(resumeReloadParam)) {
  initialUrl.searchParams.delete(resumeReloadParam);
  window.history.replaceState(null, "", `${initialUrl.pathname}${initialUrl.search}${initialUrl.hash}`);
}

let backgroundedAt: number | undefined;
let lastVisibleHeartbeatAt = Date.now();
let heartbeatArmed = document.readyState === "complete";
let rebuildingAfterResume = false;

const markBackgrounded = () => {
  backgroundedAt ??= Date.now();
};

const rebuildRuntimeAfterResume = () => {
  if (rebuildingAfterResume || document.visibilityState !== "visible") return false;
  const now = Date.now();
  const backgroundDuration = backgroundedAt === undefined ? 0 : now - backgroundedAt;
  const missedHeartbeat = heartbeatArmed && now - lastVisibleHeartbeatAt >= missedHeartbeatThresholdMs;
  lastVisibleHeartbeatAt = now;

  if (backgroundDuration < signalledBackgroundThresholdMs && !missedHeartbeat) {
    backgroundedAt = undefined;
    return false;
  }

  rebuildingAfterResume = true;
  const resumeUrl = new URL(window.location.href);
  resumeUrl.searchParams.set(resumeReloadParam, String(now));
  // A new navigation is more reliable than reload() when iOS revives a
  // suspended standalone Web App from its preserved page snapshot.
  window.location.replace(resumeUrl.toString());
  return true;
};

const onVisibilityChange = () => {
  if (document.visibilityState === "hidden") markBackgrounded();
  else rebuildRuntimeAfterResume();
};

window.addEventListener("blur", markBackgrounded);
window.addEventListener("pagehide", markBackgrounded);
window.addEventListener("focus", rebuildRuntimeAfterResume);
window.addEventListener("pageshow", rebuildRuntimeAfterResume);
document.addEventListener("freeze", markBackgrounded);
document.addEventListener("resume", rebuildRuntimeAfterResume);
document.addEventListener("visibilitychange", onVisibilityChange);

if (!heartbeatArmed) {
  window.addEventListener("load", () => {
    heartbeatArmed = true;
    lastVisibleHeartbeatAt = Date.now();
  }, { once: true });
}

window.setInterval(() => {
  if (document.visibilityState !== "visible" || rebuildingAfterResume) return;
  if (!rebuildRuntimeAfterResume()) lastVisibleHeartbeatAt = Date.now();
}, foregroundHeartbeatIntervalMs);

let reloadingForUpdate = false;
navigator.serviceWorker?.addEventListener("controllerchange", () => {
  if (reloadingForUpdate) return;
  reloadingForUpdate = true;
  window.location.reload();
});

registerSW({
  immediate: true,
  onRegisteredSW: (_swUrl, registration) => {
    if (!registration) return;
    const checkForUpdate = () => {
      if (navigator.onLine) void registration.update();
    };
    checkForUpdate();
    window.addEventListener("pageshow", checkForUpdate);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdate();
    });
    window.setInterval(() => {
      checkForUpdate();
    }, 60 * 60 * 1000);
  },
});

createRoot(document.getElementById("root")!).render(<App />);
