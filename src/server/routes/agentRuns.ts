import { once } from "node:events";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import {
  AgentApiErrorResponseSchema,
  AgentSessionStateSchema,
  AgentRunProtocol,
  AgentRunEventSchema,
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

export type AgentRunRouteDeps = {
  authService: AuthService;
  agentRunService: SlideXAgentRunService;
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
    const subscription = new AbortController();
    const abortSubscription = () => subscription.abort();
    req.once("aborted", abortSubscription);
    res.once("close", abortSubscription);

    try {
      const user = await deps.authService.requireUserFromRequest(req);
      const runId = requireRunId(req);
      const afterSequence = parseReplayCursor(req.query.after ?? req.header("Last-Event-ID"));
      const events = deps.agentRunService.subscribe({
        userId: user.id,
        runId,
        afterSequence,
        signal: subscription.signal
      });

      setSseHeaders(res);
      for await (const event of events) {
        await sendEvent(res, AgentRunEventSchema.parse(event), subscription.signal);
      }
      endResponse(res);
    } catch (error) {
      if (subscription.signal.aborted) {
        return;
      }
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
      endResponse(res);
    } finally {
      req.off("aborted", abortSubscription);
      res.off("close", abortSubscription);
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

function setSseHeaders(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

async function sendEvent(
  res: Response,
  event: ReturnType<typeof AgentRunEventSchema.parse>,
  signal: AbortSignal
): Promise<void> {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  const frame = `event: ${event.kind}\nid: ${event.sequence}\ndata: ${AgentRunProtocol.stringifyEvent(event)}\n\n`;
  if (!res.write(frame)) {
    await once(res, "drain", { signal });
  }
}

function endResponse(res: Response): void {
  if (!res.destroyed && !res.writableEnded) {
    res.end();
  }
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

function parseReplayCursor(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new SlideXAgentRunServiceError(
      "invalid_request",
      "Agent run replay cursor must be a non-negative integer"
    );
  }
  return cursor;
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
  if (error instanceof ZodError) {
    return {
      code: "invalid_request",
      message: "The agent request was invalid",
      status: ERROR_STATUS.invalid_request
    };
  }
  return {
    code: "internal_error",
    message: "The agent service could not complete the request",
    status: ERROR_STATUS.internal_error
  };
}
