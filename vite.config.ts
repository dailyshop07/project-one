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
        // Keep iOS Safari's current-page install behavior when supported. The
        // invite cookie is the authoritative handoff because Home Screen Web
        // Apps have an isolated localStorage/IndexedDB container.
        start_url: "",
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
