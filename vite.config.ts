import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev proxy targets the API server. Both read PORT, so `PORT=3010 npm run dev`
// keeps them in sync. Vite auto-picks a free web port if 5173 is taken.
const serverTarget = `http://localhost:${process.env.PORT ?? "3000"}`;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist-client",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/trpc": serverTarget,
      "/api": serverTarget,
      "/healthz": serverTarget
    }
  }
});
