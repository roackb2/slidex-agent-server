import "dotenv/config";
import { AuthService } from "./auth.js";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { StdioMcpProcessManager } from "./mcp/stdioMcp.js";
import { SessionStore } from "./storage/sessionStore.js";

const env = loadEnv();
const sessionStore = new SessionStore(env.dataDir);
await sessionStore.ensureReady();

const authService = new AuthService(env);
const mcpManager = new StdioMcpProcessManager(env);
const app = createApp({
  env,
  authService,
  sessionStore,
  mcpManager
});

const server = app.listen(env.PORT, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : env.PORT;
  console.log(`SlideX agent server listening on :${boundPort}`);
  console.log(`Session data directory: ${env.dataDir}`);
  console.log(`Agent driver: ${env.AGENT_DRIVER}`);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${env.PORT} is already in use. Set PORT to a free port, or run \`npm run dev\` which allocates free ports automatically.`
    );
    process.exit(1);
  }
  throw error;
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function shutdown() {
  console.log("Shutting down SlideX agent server");
  server.close();
  await mcpManager.stop();
  process.exit(0);
}
