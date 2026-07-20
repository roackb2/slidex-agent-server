import type { Request, Response } from "express";
import { ZodError } from "zod";
import {
  ConversationRunSseReplayCursorError,
  parseConversationRunSseReplayCursor,
  streamConversationRunSse
} from "@roackb2/heddle/hosted/http-sse";
import {
  AgentApiErrorResponseSchema,
  AgentSessionPageSchema,
  AgentSessionStateSchema,
  AgentRunProtocol,
  AttachAgentSessionInputSchema,
  AttachAgentSessionResultSchema,
  ListAgentSessionsQuerySchema,
  ResetAgentSessionResultSchema,
  StartAgentRunInputSchema,
  StartAgentRunResultSchema,
  type AgentApiErrorCode
} from "../../shared/schema.js";
import { AuthError, type AuthService } from "../auth.js";
import {
  SlideXAgentRunServiceError,
  type SlideXAgentRunService
} from "../agent/slidexAgentRunService.js";
import {
  SessionCatalogCursorError,
  type AgentSessionRepository
} from "../storage/agentSessionRepository.js";

export type AgentRunRouteDeps = {
  authService: AuthService;
  agentRunService: SlideXAgentRunService;
};

export type AgentSessionCatalogRouteDeps = {
  authService: AuthService;
  agentSessionRepository: AgentSessionRepository;
};

export function createStartAgentRunHandler(deps: AgentRunRouteDeps) {
  return async (req: Request, res: Response) => {
    try {
      const user = await deps.authService.requireUserFromRequest(req);
      const result = await deps.agentRunService.start(
        user,
        StartAgentRunInputSchema.parse(req.body),
        { correlationId: typeof req.id === "string" ? req.id : undefined }
      );
      res.status(202).json(StartAgentRunResultSchema.parse(result));
    } catch (error) {
      sendRequestError(res, error);
    }
  };
}

export function createSubscribeAgentRunHandler(deps: AgentRunRouteDeps) {
  return async (req: Request, res: Response) => {
    try {
      const user = await deps.authService.requireUserFromRequest(req);
      const runId = requireRunId(req);
      const afterSequence = parseConversationRunSseReplayCursor({
        query: req.query.after,
        lastEventId: req.header("Last-Event-ID")
      });
      await streamConversationRunSse({
        request: req,
        response: res,
        protocol: AgentRunProtocol,
        subscribe: (signal) => deps.agentRunService.subscribe({
          userId: user.id,
          runId,
          afterSequence,
          signal
        })
      });
    } catch (error) {
      if (!res.headersSent) {
        sendRequestError(res, error);
        return;
      }
      req.log?.error({
        event: "agent_stream.failed",
        runId: req.params.runId ?? "unknown",
        errorType: errorType(error),
        validationIssueCount: validationIssueCount(error)
      }, "Agent event stream failed");
    }
  };
}

export function createGetAgentSessionHandler(deps: AgentRunRouteDeps) {
  return async (req: Request, res: Response) => {
    try {
      const user = await deps.authService.requireUserFromRequest(req);
      const state = await deps.agentRunService.getSessionState(user.id, requireSessionId(req));
      res.json(AgentSessionStateSchema.parse(state));
    } catch (error) {
      sendRequestError(res, error);
    }
  };
}

export function createListAgentSessionsHandler(deps: AgentSessionCatalogRouteDeps) {
  return async (req: Request, res: Response) => {
    try {
      const user = await deps.authService.requireUserFromRequest(req);
      const query = ListAgentSessionsQuerySchema.parse(req.query);
      const page = await deps.agentSessionRepository.listAgentSessions(user.id, query);
      res.json(AgentSessionPageSchema.parse(page));
    } catch (error) {
      sendRequestError(res, error);
    }
  };
}

export function createAttachAgentSessionHandler(deps: AgentRunRouteDeps) {
  return async (req: Request, res: Response) => {
    try {
      const user = await deps.authService.requireUserFromRequest(req);
      const session = await deps.agentRunService.attachSessionToPresentation(
        user.id,
        requireSessionId(req),
        AttachAgentSessionInputSchema.parse(req.body)
      );
      res.json(AttachAgentSessionResultSchema.parse({ session }));
    } catch (error) {
      sendRequestError(res, error);
    }
  };
}

export function createResetAgentSessionHandler(deps: AgentRunRouteDeps) {
  return async (req: Request, res: Response) => {
    try {
      const user = await deps.authService.requireUserFromRequest(req);
      const result = await deps.agentRunService.resetSession(user.id, requireSessionId(req));
      res.json(ResetAgentSessionResultSchema.parse(result));
    } catch (error) {
      sendRequestError(res, error);
    }
  };
}

export function createCancelAgentRunHandler(deps: AgentRunRouteDeps) {
  return async (req: Request, res: Response) => {
    try {
      const user = await deps.authService.requireUserFromRequest(req);
      const cancelled = deps.agentRunService.cancel(user.id, requireRunId(req));
      res.json({ cancelled });
    } catch (error) {
      sendRequestError(res, error);
    }
  };
}

function requireRunId(req: Request): string {
  const runId = req.params.runId;
  if (!runId) {
    throw new SlideXAgentRunServiceError("invalid_request", "Agent run id is required");
  }
  return runId;
}

function requireSessionId(req: Request): string {
  const sessionId = req.params.sessionId;
  if (!sessionId) {
    throw new SlideXAgentRunServiceError("invalid_request", "Conversation id is required");
  }
  return sessionId;
}

function sendRequestError(res: Response, error: unknown): void {
  const response = toAgentApiError(error);
  if (response.code === "internal_error") {
    res.req.log?.error({
      event: "agent_request.failed",
      code: response.code,
      status: response.status,
      errorType: errorType(error)
    }, "Agent request failed");
  }
  res.status(response.status).json(AgentApiErrorResponseSchema.parse({
    error: {
      code: response.code,
      message: response.message
    }
  }));
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function validationIssueCount(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("issues" in error)) {
    return undefined;
  }
  return Array.isArray(error.issues) ? error.issues.length : undefined;
}

const ERROR_STATUS = {
  auth_required: 401,
  invalid_request: 400,
  rate_limited: 429,
  model_auth_unavailable: 502,
  session_not_found: 404,
  run_not_found: 404,
  active_run_conflict: 409,
  replay_unavailable: 409,
  internal_error: 500
} satisfies Record<AgentApiErrorCode, number>;

function toAgentApiError(error: unknown): {
  code: AgentApiErrorCode;
  message: string;
  status: number;
} {
  if (error instanceof AuthError) {
    return {
      code: "auth_required",
      message: "Authentication required",
      status: ERROR_STATUS.auth_required
    };
  }
  if (error instanceof SlideXAgentRunServiceError) {
    return {
      code: error.code,
      message: error.message,
      status: ERROR_STATUS[error.code]
    };
  }
  if (error instanceof ConversationRunSseReplayCursorError || error instanceof ZodError) {
    return {
      code: "invalid_request",
      message: "The agent request was invalid",
      status: ERROR_STATUS.invalid_request
    };
  }
  if (error instanceof SessionCatalogCursorError) {
    return {
      code: "invalid_request",
      message: error.message,
      status: ERROR_STATUS.invalid_request
    };
  }
  return {
    code: "internal_error",
    message: "The agent service could not complete the request",
    status: ERROR_STATUS.internal_error
  };
}
