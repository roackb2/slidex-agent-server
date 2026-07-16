import "dotenv/config";
import { AuthService } from "./auth.js";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createGracefulShutdown } from "./lifecycle/gracefulShutdown.js";
import { StdioMcpProcessManager } from "./mcp/stdioMcp.js";
import { createServerLogger } from "./observability/logger.js";
import { SessionStore } from "./storage/sessionStore.js";
import { createAgentSessionRepository } from "./storage/supabaseAgentSessionRepository.js";

const env = loadEnv();
const logger = createServerLogger(env);
const sessionStore = new SessionStore(env.dataDir);
await sessionStore.ensureReady();
const agentSessionRepository = createAgentSessionRepository(env, sessionStore);

const authService = new AuthService(env);
const mcpManager = new StdioMcpProcessManager(env);
const app = createApp({
  env,
  authService,
  sessionStore,
  agentSessionRepository,
  mcpManager,
  logger
});

const server = app.listen(env.PORT, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : env.PORT;
  logger.info({
    event: "server.started",
    port: boundPort,
    dataDir: env.dataDir,
    agentDriver: env.AGENT_DRIVER,
    productSessionStorage: env.SLIDEX_PRODUCT_SESSION_STORAGE
  }, "SlideX agent server listening");
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    logger.error({ event: "server.bind_failed", port: env.PORT },
      `Port ${env.PORT} is already in use. Set PORT to a free port, or run \`npm run dev\` which allocates free ports automatically.`);
    process.exit(1);
  }
  throw error;
});

const shutdown = createGracefulShutdown({
  server,
  logger,
  graceMs: env.SHUTDOWN_GRACE_MS,
  stopResources: () => mcpManager.stop(),
  exit: (code) => {
    logger.flush();
    process.exit(code);
  }
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
