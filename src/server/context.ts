import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import type { AuthService, AuthUser } from "./auth.js";
import type { Env } from "./env.js";
import type { AgentSessionRepository } from "./storage/agentSessionRepository.js";
import type {
  PresentationDocumentRepository
} from "./storage/presentationDocumentRepository.js";
import type { SessionStore } from "./storage/sessionStore.js";

export type ServerDeps = {
  env: Env;
  authService: AuthService;
  sessionStore: SessionStore;
  agentSessionRepository?: AgentSessionRepository;
  presentationDocumentRepository?: PresentationDocumentRepository;
  logger?: Logger;
};

export type AppContext = {
  req: Request;
  res: Response;
  user: AuthUser | null;
  deps: ServerDeps;
};

export function createContextFactory(deps: ServerDeps) {
  return async ({ req, res }: CreateExpressContextOptions): Promise<AppContext> => {
    const user = await deps.authService.getUserFromRequest(req).catch(() => null);
    return {
      req,
      res,
      user,
      deps
    };
  };
}
