import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const devHost = process.env.TAURI_DEV_HOST || "";
// @ts-expect-error process is a nodejs global
const privateReader = process.env.VITE_PRIVATE_READER === "1";
const host = devHost ? "0.0.0.0" : "127.0.0.1";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  define: { "import.meta.env.VITE_PRIVATE_READER": JSON.stringify(privateReader ? "1" : "0") },
  resolve: { alias: privateReader ? [] : [{ find: "./components/YatsuWorkspace", replacement: "/src/components/DisabledReaderWorkspace.tsx" }] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host,
    hmr: devHost
      ? {
          protocol: "ws",
          host: devHost,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        jl: "jl-window.html",
        jlPopup: "jl-popup.html",
        lookup: "lookup-window.html",
        ...(privateReader ? { yatsuLookup: "yatsu-lookup.html" } : {}),
        captureRegion: "capture-region.html",
      },
    },
  },
}));
