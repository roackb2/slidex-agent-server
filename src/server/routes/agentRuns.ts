import { once } from "node:events";
import type { Request, Response } from "express";
import {
  AgentRunProtocol,
  AgentRunEventSchema,
  StartAgentRunInputSchema,
  StartAgentRunResultSchema
} from "../../shared/schema.js";
import { AuthError, type AuthService } from "../auth.js";
import type { SlideXAgentRunService } from "../agent/slidexAgentRunService.js";
import { toPublicErrorMessage } from "./agentStream.js";

export type AgentRunRouteDeps = {
  authService: AuthService;
  agentRunService: SlideXAgentRunService;
};

export function createStartAgentRunHandler(deps: AgentRunRouteDeps) {
  return async (req: Request, res: Response) => {
    try {
      const user = await deps.authService.requireUserFromRequest(req);
      const result = await deps.agentRunService.start(user, StartAgentRunInputSchema.parse(req.body));
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
      console.error(`[agent-runs] Event stream failed for ${req.params.runId ?? "unknown run"}`, error);
      if (typeof error === "object" && error !== null && "issues" in error) {
        console.error("[agent-runs] Validation issues", error.issues);
      }
      endResponse(res);
    } finally {
      req.off("aborted", abortSubscription);
      res.off("close", abortSubscription);
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
    throw new Error("Agent run id is required");
  }
  return runId;
}

function parseReplayCursor(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("Agent run replay cursor must be a non-negative integer");
  }
  return cursor;
}

function sendRequestError(res: Response, error: unknown): void {
  const status = error instanceof AuthError ? 401 : 400;
  res.status(status).json({ error: toPublicErrorMessage(error) });
}
