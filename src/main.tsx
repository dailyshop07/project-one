import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import "./styles.css";

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
