import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { nanoid } from "nanoid";
import {
  ChatMessageSchema,
  SessionSchema,
  type AgentSessionPage,
  type ChatMessage,
  type Session,
  type SessionSummary
} from "../../shared/schema.js";
import {
  AgentSessionIdempotencyConflictError,
  AgentSessionPresentationConflictError,
  compareAgentSessionsNewestFirst,
  decodeAgentSessionCursor,
  encodeAgentSessionCursor,
  isAgentSessionAfterCursor,
  type AgentSessionRepository,
  type AppendAgentSessionMessageInput,
  type CreateAgentSessionInput
} from "./agentSessionRepository.js";

type BoundSession = Session & {
  presentationId: string;
  presentationTitle: string;
};

export class SessionStore implements AgentSessionRepository {
  constructor(private readonly rootDir: string) {}

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.sessionsRoot, { recursive: true });
  }

  async listSessions(userId: string): Promise<SessionSummary[]> {
    return (await this.readUserSessions(userId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => ({
        id: session.id,
        userId: session.userId,
        title: session.title,
        presentationId: session.presentationId,
        presentationTitle: session.presentationTitle,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        hasMotionDoc: session.latestMotionDoc.trim().length > 0
      }));
  }

  /**
   * Returns a bounded, stable catalog projection. Conversation contents remain
   * private to the authorized detail endpoint and never enter list responses.
   */
  async listAgentSessions(
    userId: string,
    input: { limit: number; cursor?: string }
  ): Promise<AgentSessionPage> {
    const cursor = input.cursor ? decodeAgentSessionCursor(input.cursor) : undefined;
    const sessions = (await this.readUserSessions(userId))
      .filter(isBoundSession)
      .sort((left, right) => compareAgentSessionsNewestFirst(
        { id: left.id, lastActivityAt: left.updatedAt },
        { id: right.id, lastActivityAt: right.updatedAt }
      ))
      .filter((session) => !cursor || isAgentSessionAfterCursor(
        { id: session.id, lastActivityAt: session.updatedAt },
        cursor
      ));
    const page = sessions.slice(0, input.limit + 1);
    const visible = page.slice(0, input.limit);
    const last = visible.at(-1);

    return {
      items: visible.map((session) => ({
        id: session.id,
        title: session.title,
        presentation: {
          id: session.presentationId,
          title: session.presentationTitle
        },
        createdAt: session.createdAt,
        lastActivityAt: session.updatedAt,
        messageCount: session.messages.length
      })),
      ...(page.length > input.limit && last
        ? { nextCursor: encodeAgentSessionCursor({
            id: last.id,
            lastActivityAt: last.updatedAt
          }) }
        : {})
    };
  }

  async createSession(input: CreateAgentSessionInput): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id: nanoid(),
      userId: input.userId,
      title: input.title ?? "Untitled deck",
      ...(input.presentationId ? { presentationId: input.presentationId } : {}),
      ...(input.presentationTitle ? { presentationTitle: input.presentationTitle } : {}),
      createdAt: now,
      updatedAt: now,
      latestMotionDoc: input.motionDoc ?? "",
      messages: []
    };

    await this.writeSession(session);
    return session;
  }

  async getSession(userId: string, sessionId: string): Promise<Session | null> {
    const file = this.sessionPath(userId, sessionId);
    try {
      const session = await this.readSessionFile(file);
      return session.userId === userId ? session : null;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async requireSession(userId: string, sessionId: string): Promise<Session> {
    const session = await this.getSession(userId, sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    return session;
  }

  async writeSession(session: Session): Promise<Session> {
    const parsed = SessionSchema.parse({
      ...session,
      updatedAt: new Date().toISOString(),
      messages: session.messages.map((message) => ChatMessageSchema.parse(message))
    });

    const dir = this.userDir(parsed.userId);
    await fs.mkdir(dir, { recursive: true });
    const file = this.sessionPath(parsed.userId, parsed.id);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
    await fs.rename(tmp, file);
    return parsed;
  }

  async appendMessage(userId: string, sessionId: string, message: ChatMessage): Promise<Session> {
    const session = await this.requireSession(userId, sessionId);
    session.messages.push(message);
    return this.writeSession(session);
  }

  async attachSessionToPresentation(
    userId: string,
    sessionId: string,
    input: { presentationId: string; presentationTitle: string }
  ): Promise<Session | null> {
    const session = await this.getSession(userId, sessionId);
    if (!session) {
      return null;
    }
    if (session.presentationId && session.presentationId !== input.presentationId) {
      throw new AgentSessionPresentationConflictError();
    }
    if (
      session.presentationId === input.presentationId
      && session.presentationTitle === input.presentationTitle
    ) {
      return session;
    }
    return this.writeSession({
      ...session,
      presentationId: input.presentationId,
      presentationTitle: input.presentationTitle
    });
  }

  async appendRunMessage(input: AppendAgentSessionMessageInput): Promise<Session | null> {
    const session = await this.getSession(input.userId, input.sessionId);
    if (!session) {
      return null;
    }

    const metadata = {
      ...(input.metadata ?? {}),
      runId: input.runId,
      kind: input.kind
    };
    const existing = session.messages.find((message) =>
      message.metadata?.runId === input.runId
      && message.metadata.kind === input.kind
    );
    if (existing) {
      if (
        existing.role === input.role
        && existing.content === input.content
        && isDeepStrictEqual(existing.metadata, metadata)
      ) {
        return session;
      }
      throw new AgentSessionIdempotencyConflictError(
        input.sessionId,
        input.runId,
        input.kind
      );
    }

    if (input.latestMotionDoc !== undefined) {
      session.latestMotionDoc = input.latestMotionDoc;
    }
    session.messages.push(makeMessage({
      role: input.role,
      content: input.content,
      metadata
    }));
    return this.writeSession(session);
  }

  async renameSession(userId: string, sessionId: string, title: string): Promise<Session> {
    const session = await this.requireSession(userId, sessionId);
    session.title = title;
    return this.writeSession(session);
  }

  async deleteSession(userId: string, sessionId: string): Promise<{ ok: true }> {
    const file = this.sessionPath(userId, sessionId);
    try {
      await fs.unlink(file);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
    return { ok: true };
  }

  private async readSessionFile(file: string): Promise<Session> {
    const text = await fs.readFile(file, "utf8");
    return SessionSchema.parse(JSON.parse(text));
  }

  private async readUserSessions(userId: string): Promise<Session[]> {
    await this.ensureReady();
    const dir = this.userDir(userId);
    await fs.mkdir(dir, { recursive: true });
    const names = await fs.readdir(dir);
    const sessions = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => this.readSessionFile(path.join(dir, name)).catch(() => null))
    );
    return sessions.filter((session): session is Session => Boolean(session));
  }

  private get sessionsRoot(): string {
    return path.join(this.rootDir, "sessions");
  }

  private userDir(userId: string): string {
    return path.join(this.sessionsRoot, safePathSegment(userId));
  }

  private sessionPath(userId: string, sessionId: string): string {
    return path.join(this.userDir(userId), `${safePathSegment(sessionId)}.json`);
  }
}

function isBoundSession(session: Session): session is BoundSession {
  return Boolean(session.presentationId && session.presentationTitle);
}

export function makeMessage(input: Omit<ChatMessage, "id" | "createdAt">): ChatMessage {
  return {
    id: nanoid(),
    createdAt: new Date().toISOString(),
    ...input
  };
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
