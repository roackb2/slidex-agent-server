import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import * as trpcExpress from "@trpc/server/adapters/express";
import { appRouter } from "./router.js";
import { createContextFactory, type ServerDeps } from "./context.js";
import { createAgentStreamHandler, type AgentStreamDeps } from "./routes/agentStream.js";
import { SlideXAgentRunService } from "./agent/slidexAgentRunService.js";
import {
  createAttachAgentSessionHandler,
  createCancelAgentRunHandler,
  createGetAgentSessionHandler,
  createListAgentSessionsHandler,
  createResetAgentSessionHandler,
  createStartAgentRunHandler,
  createSubscribeAgentRunHandler
} from "./routes/agentRuns.js";
import { createHttpLogger, createServerLogger } from "./observability/logger.js";
import { createCorsOriginPolicy } from "./http/corsPolicy.js";
import {
  createOpenAiDeviceCodePollRateLimit,
  createOpenAiDeviceCodeStartRateLimit,
  createPollOpenAiDeviceCodeHandler,
  createRequestOpenAiDeviceCodeHandler,
  type OpenAiDeviceCodeAuthPort
} from "./routes/modelAuth.js";

type AppDeps = ServerDeps & Pick<AgentStreamDeps, "mcpManager"> & {
  deviceCodeAuth?: OpenAiDeviceCodeAuthPort;
};

export function createApp(deps: AppDeps) {
  const app = express();
  const logger = deps.logger ?? createServerLogger(deps.env);
  const agentSessionRepository = deps.agentSessionRepository ?? deps.sessionStore;

  app.disable("x-powered-by");
  app.use(createHttpLogger(logger));
  app.use(
    cors({
      origin: createCorsOriginPolicy(deps.env.CORS_ORIGIN, {
        requireExplicitAllowlist:
          deps.env.NODE_ENV === "production" && deps.env.SLIDEX_AGENT_ENABLED
      }),
      credentials: false
    })
  );
  app.use(express.json({ limit: "10mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      agentDriver: deps.env.AGENT_DRIVER,
      dataDir: deps.env.dataDir,
      productSessionStorage: deps.env.SLIDEX_PRODUCT_SESSION_STORAGE,
      presentationFinalization: deps.presentationDocumentRepository
        ? "supabase"
        : "pending",
      mcpConfigured: deps.mcpManager.configured
    });
  });

  app.use(
    "/trpc",
    trpcExpress.createExpressMiddleware({
      router: appRouter,
      createContext: createContextFactory(deps)
    })
  );

  app.post("/api/agent/stream", createAgentStreamHandler(deps));
  if (deps.env.SLIDEX_AGENT_ENABLED) {
    const agentRunService = new SlideXAgentRunService({
      env: deps.env,
      agentSessionRepository,
      presentationDocumentRepository: deps.presentationDocumentRepository,
      logger: logger.child({ component: "agent-run-service" })
    });
    const agentRunRouteDeps = {
      authService: deps.authService,
      agentRunService
    };
    const modelAuthRouteDeps = {
      authService: deps.authService,
      deviceCodeAuth: deps.deviceCodeAuth
    };

    app.post("/api/agent/runs", createStartAgentRunHandler(agentRunRouteDeps));
    app.post(
      "/api/agent/model-auth/openai/device-code",
      createOpenAiDeviceCodeStartRateLimit(),
      createRequestOpenAiDeviceCodeHandler(modelAuthRouteDeps)
    );
    app.post(
      "/api/agent/model-auth/openai/device-code/poll",
      createOpenAiDeviceCodePollRateLimit(),
      createPollOpenAiDeviceCodeHandler(modelAuthRouteDeps)
    );
    app.get("/api/agent/sessions", createListAgentSessionsHandler({
      authService: deps.authService,
      agentSessionRepository
    }));
    app.get("/api/agent/sessions/:sessionId", createGetAgentSessionHandler(agentRunRouteDeps));
    app.put(
      "/api/agent/sessions/:sessionId/presentation",
      createAttachAgentSessionHandler(agentRunRouteDeps)
    );
    app.delete("/api/agent/sessions/:sessionId", createResetAgentSessionHandler(agentRunRouteDeps));
    app.get("/api/agent/runs/:runId/events", createSubscribeAgentRunHandler(agentRunRouteDeps));
    app.post("/api/agent/runs/:runId/cancel", createCancelAgentRunHandler(agentRunRouteDeps));
  }

  if (deps.env.NODE_ENV === "production") {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const clientDir = path.resolve(__dirname, "../../dist-client");
    app.use(express.static(clientDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  return app;
}
