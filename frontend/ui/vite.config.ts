import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The browser talks only to this dev server. Every /api request is passed on
// to the E-Surance bridge (python bridge.py) on the same computer, so the
// page and the API share one origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const bridge = env.BRIDGE_URL || "http://127.0.0.1:8000";
  const proxy = { "/api": { target: bridge, changeOrigin: true } };
  return {
    plugins: [react(), tailwindcss()],
    server: { port: 3000, host: true, proxy },
    preview: { port: 3000, host: true, proxy },
  };
});
