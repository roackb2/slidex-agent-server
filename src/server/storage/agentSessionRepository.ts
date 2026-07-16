import { z } from "zod";
import type {
  AgentSessionPage,
  ChatMessage,
  Session
} from "../../shared/schema.js";

const AgentSessionCursorSchema = z.object({
  id: z.string().min(1),
  lastActivityAt: z.string().datetime()
}).strict();

export type AgentSessionMessageKind = "user_input" | "assistant_terminal";

export type CreateAgentSessionInput = {
  userId: string;
  title?: string;
  motionDoc?: string;
  presentationId?: string;
  presentationTitle?: string;
};

export type AppendAgentSessionMessageInput = {
  userId: string;
  sessionId: string;
  runId: string;
  kind: AgentSessionMessageKind;
  role: Extract<ChatMessage["role"], "user" | "assistant">;
  content: string;
  metadata?: Record<string, unknown>;
  latestMotionDoc?: string;
};

/**
 * Product-owned projection of one SlideX conversation.
 *
 * This is intentionally separate from Heddle's complete ChatSession record.
 * Implementations own the safe transcript, presentation association, catalog,
 * and idempotent accepted/terminal message writes.
 */
export interface AgentSessionRepository {
  listAgentSessions(
    userId: string,
    input: { limit: number; cursor?: string }
  ): Promise<AgentSessionPage>;
  createSession(input: CreateAgentSessionInput): Promise<Session>;
  getSession(userId: string, sessionId: string): Promise<Session | null>;
  attachSessionToPresentation(
    userId: string,
    sessionId: string,
    input: { presentationId: string; presentationTitle: string }
  ): Promise<Session | null>;
  appendRunMessage(input: AppendAgentSessionMessageInput): Promise<Session | null>;
  deleteSession(userId: string, sessionId: string): Promise<{ ok: true }>;
}

export class SessionCatalogCursorError extends Error {
  constructor() {
    super("Conversation catalog cursor is invalid");
    this.name = "SessionCatalogCursorError";
  }
}

export class AgentSessionPresentationConflictError extends Error {
  constructor() {
    super("Conversation belongs to a different presentation");
    this.name = "AgentSessionPresentationConflictError";
  }
}

export class AgentSessionIdempotencyConflictError extends Error {
  constructor(sessionId: string, runId: string, kind: AgentSessionMessageKind) {
    super(`Conversation ${sessionId} already has a different ${kind} message for run ${runId}`);
    this.name = "AgentSessionIdempotencyConflictError";
  }
}

export type AgentSessionCursor = z.infer<typeof AgentSessionCursorSchema>;

export type AgentSessionOrderKey = {
  id: string;
  lastActivityAt: string;
};

export function compareAgentSessionsNewestFirst(
  left: AgentSessionOrderKey,
  right: AgentSessionOrderKey
): number {
  return compareTextDescending(left.lastActivityAt, right.lastActivityAt)
    || compareTextDescending(left.id, right.id);
}

export function isAgentSessionAfterCursor(
  session: AgentSessionOrderKey,
  cursor: AgentSessionCursor
): boolean {
  return compareAgentSessionsNewestFirst(session, cursor) > 0;
}

export function encodeAgentSessionCursor(session: AgentSessionOrderKey): string {
  return Buffer.from(JSON.stringify({
    id: session.id,
    lastActivityAt: session.lastActivityAt
  })).toString("base64url");
}

export function decodeAgentSessionCursor(value: string): AgentSessionCursor {
  try {
    return AgentSessionCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    );
  } catch {
    throw new SessionCatalogCursorError();
  }
}

function compareTextDescending(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left > right ? -1 : 1;
}
