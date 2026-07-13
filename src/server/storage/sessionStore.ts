import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  ChatMessageSchema,
  SessionSchema,
  type AgentSessionPage,
  type ChatMessage,
  type Session,
  type SessionSummary
} from "../../shared/schema.js";

const AgentSessionCursorSchema = z.object({
  id: z.string().min(1),
  lastActivityAt: z.string().datetime()
}).strict();

type BoundSession = Session & {
  presentationId: string;
  presentationTitle: string;
};

export class SessionCatalogCursorError extends Error {
  constructor() {
    super("Conversation catalog cursor is invalid");
    this.name = "SessionCatalogCursorError";
  }
}

export class SessionStore {
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
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const sessions = (await this.readUserSessions(userId))
      .filter(isBoundSession)
      .sort(compareSessionsNewestFirst)
      .filter((session) => !cursor || isAfterCursor(session, cursor));
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
        ? { nextCursor: encodeCursor(last) }
        : {})
    };
  }

  async createSession(input: {
    userId: string;
    title?: string;
    motionDoc?: string;
    presentationId?: string;
    presentationTitle?: string;
  }): Promise<Session> {
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

function compareSessionsNewestFirst(left: Session, right: Session): number {
  return right.updatedAt.localeCompare(left.updatedAt)
    || right.id.localeCompare(left.id);
}

function isAfterCursor(
  session: Session,
  cursor: z.infer<typeof AgentSessionCursorSchema>
): boolean {
  return session.updatedAt < cursor.lastActivityAt
    || (session.updatedAt === cursor.lastActivityAt && session.id < cursor.id);
}

function encodeCursor(session: Pick<Session, "id" | "updatedAt">): string {
  return Buffer.from(JSON.stringify({
    id: session.id,
    lastActivityAt: session.updatedAt
  })).toString("base64url");
}

function decodeCursor(value: string): z.infer<typeof AgentSessionCursorSchema> {
  try {
    return AgentSessionCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    );
  } catch {
    throw new SessionCatalogCursorError();
  }
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
