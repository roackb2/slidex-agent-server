import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev orchestrator (scripts/dev.mjs) passes the resolved API server port as
// SERVER_PORT so the proxy targets whatever free port the server bound.
const serverTarget = `http://localhost:${process.env.SERVER_PORT ?? "3000"}`;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist-client",
    emptyOutDir: true
  },
  server: {
    port: Number(process.env.WEB_PORT) || 5173,
    proxy: {
      "/trpc": serverTarget,
      "/api": serverTarget,
      "/healthz": serverTarget
    }
  }
});
