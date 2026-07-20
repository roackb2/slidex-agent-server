import type { Request, Response } from "express";
import { AgentStreamInputSchema, type AgentStreamEvent } from "../../shared/schema.js";
import { AuthError } from "../auth.js";
import type { AuthService } from "../auth.js";
import type { Env } from "../env.js";
import type { StdioMcpProcessManager } from "../mcp/stdioMcp.js";
import { createAgentDriver } from "../agent/runtime.js";
import type { AgentDriver } from "../agent/types.js";
import { makeMessage, type SessionStore } from "../storage/sessionStore.js";

export type AgentStreamDeps = {
  env: Env;
  authService: AuthService;
  sessionStore: SessionStore;
  mcpManager: StdioMcpProcessManager;
  agentDriver?: AgentDriver;
};

export function createAgentStreamHandler(deps: AgentStreamDeps) {
  const agentDriver = deps.agentDriver ?? createAgentDriver(deps.env);

  return async (req: Request, res: Response) => {
    try {
      const user = await deps.authService.requireUserFromRequest(req);
      const input = AgentStreamInputSchema.parse(req.body);
      const abortController = new AbortController();
      req.on("close", () => abortController.abort());

      setSseHeaders(res);

      let session = input.sessionId
        ? await deps.sessionStore.getSession(user.id, input.sessionId)
        : null;

      if (!session) {
        session = await deps.sessionStore.createSession({
          userId: user.id,
          title: input.title ?? titleFromMessage(input.message),
          motionDoc: input.motionDoc
        });
      }

      session.messages.push(
        makeMessage({
          role: "user",
          content: input.message
        })
      );
      session.latestMotionDoc = input.motionDoc;
      session = await deps.sessionStore.writeSession(session);
      sendEvent(res, { type: "session", session });

      let streamedAssistantText = "";
      const result = await agentDriver.run({
        user,
        sessionId: session.id,
        motionDoc: input.motionDoc,
        message: input.message,
        modelCredential: input.modelCredential,
        model: input.model || deps.env.DEFAULT_MODEL,
        signal: abortController.signal,
        emit: async (event) => {
          if (event.type === "token") {
            streamedAssistantText += event.text;
          }
          sendEvent(res, event);
        }
      });

      session.latestMotionDoc = result.motionDoc;
      session.messages.push(
        makeMessage({
          role: "assistant",
          content: result.assistantMessage || streamedAssistantText.trim(),
          metadata: result.metadata
        })
      );
      session = await deps.sessionStore.writeSession(session);

      sendEvent(res, { type: "motionDoc", motionDoc: result.motionDoc });
      sendEvent(res, { type: "complete", session, motionDoc: result.motionDoc });
      res.end();
    } catch (error) {
      if (!res.headersSent) {
        if (error instanceof AuthError) {
          res.status(401).json({ error: error.message });
          return;
        }
        res.status(400).json({ error: toPublicErrorMessage(error) });
        return;
      }

      sendEvent(res, {
        type: "error",
        message: toPublicErrorMessage(error)
      });
      res.end();
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

function sendEvent(res: Response, event: AgentStreamEvent): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function titleFromMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled deck";
}

export function toPublicErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***")
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._-]{8,}/gi, "$1***");
}
