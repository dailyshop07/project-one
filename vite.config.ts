import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative assets allow the same build to work at any GitHub Pages sub-path.
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["project-one-logo-v2.png"],
      manifest: {
        id: "./",
        name: "Daily Shop",
        short_name: "Daily Shop",
        description: "A private, local-first daily operations app.",
        lang: "zh-CN",
        // Do not force the Home Screen app back to the repository root. When
        // installed from an invitation URL, iOS can use the current page as
        // the launch URL and carry the one-time `?pair=...` handoff into the
        // standalone app. Safari and the Home Screen app have separate
        // IndexedDB/localStorage containers, so losing this URL loses the
        // pairing identity.
        // Vite PWA's default is `./`; omit the member in the generated
        // manifest so Safari can fall back to the invitation page URL.
        start_url: undefined as unknown as string,
        scope: "./",
        display: "standalone",
        orientation: "portrait-primary",
        background_color: "#f4f1ea",
        theme_color: "#17352d",
        categories: ["productivity"],
        icons: [
          { src: "project-one-logo-v2.png", sizes: "1254x1254", type: "image/png", purpose: "any" },
          { src: "project-one-logo-v2.png", sizes: "1254x1254", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        globPatterns: ["**/*.{js,css,html,ico,jpg,jpeg,png,webmanifest}"],
        runtimeCaching: []
      }
    })
  ],
  build: {
    target: "es2022",
    sourcemap: false
  }
});
