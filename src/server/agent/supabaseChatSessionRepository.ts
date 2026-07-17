import {
  ChatSessionAlreadyExistsError,
  ChatSessionRevisionConflictError,
  ChatSessionStorageCorruptionError,
  InvalidChatSessionCursorError,
  type ChatSession,
  type ChatSessionCatalogEntry,
  type ChatSessionCatalogPage,
  type ChatSessionRepository,
  type DeleteChatSessionInput,
  type ListChatSessionsInput,
  type StoredChatSession,
  type UpdateChatSessionInput
} from "@roackb2/heddle";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const AGENT_SESSION_RECORDS_TABLE = "agent_session_records";
const RECORD_FORMAT = 1;

const CatalogEntrySchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  name: z.string(),
  pinned: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
}).passthrough();

const ChatSessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  pinned: z.boolean(),
  history: z.array(z.unknown()),
  messages: z.array(z.unknown()),
  turns: z.array(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  queuedPrompts: z.array(z.unknown())
}).passthrough();

const CatalogRowSchema = z.object({
  session_id: z.string(),
  revision: z.number().int().positive(),
  catalog: z.unknown()
});

const SessionRowSchema = z.object({
  session_id: z.string(),
  revision: z.number().int().positive(),
  record: z.unknown()
});

const RevisionRowSchema = z.object({
  revision: z.number().int().positive()
});

type SessionCursor = Pick<ChatSessionCatalogEntry, "id" | "pinned" | "updatedAt">;

type SupabaseFailure = {
  code?: string;
  message?: string;
};

/**
 * Supabase adapter for Heddle's complete, revisioned conversation record.
 *
 * Every instance is scoped to one verified SlideX user. The trusted service
 * role bypasses browser RLS, so every query must retain the explicit user_id
 * predicate enforced here.
 */
export class SupabaseChatSessionRepository implements ChatSessionRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly userId: string
  ) {
    if (!userId.trim()) {
      throw new TypeError("Supabase chat session repositories require a verified user ID.");
    }
  }

  async list(input: ListChatSessionsInput): Promise<ChatSessionCatalogPage> {
    validatePageLimit(input.limit);
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    let query = this.client
      .from(AGENT_SESSION_RECORDS_TABLE)
      .select("session_id,revision,catalog")
      .eq("user_id", this.userId);

    if (input.workspaceId !== undefined) {
      query = query.eq("workspace_id", input.workspaceId);
    }
    if (input.archived !== undefined) {
      query = input.archived
        ? query.not("archived_at", "is", null)
        : query.is("archived_at", null);
    }
    if (cursor) {
      query = query.or(buildCursorFilter(cursor));
    }

    const { data, error } = await query
      .order("pinned", { ascending: false })
      .order("session_updated_at", { ascending: false })
      .order("session_id", { ascending: true })
      .limit(input.limit + 1);
    throwIfSupabaseFailed("list", error);

    const entries = (data ?? []).map(parseCatalogRow);
    const items = entries.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: entries.length > input.limit && last
        ? encodeCursor(last)
        : undefined
    };
  }

  async read(sessionId: string): Promise<StoredChatSession | undefined> {
    const { data, error } = await this.client
      .from(AGENT_SESSION_RECORDS_TABLE)
      .select("session_id,revision,record")
      .eq("session_id", sessionId)
      .eq("user_id", this.userId)
      .maybeSingle();
    throwIfSupabaseFailed("read", error);
    return data ? parseSessionRow(data) : undefined;
  }

  async create(session: ChatSession): Promise<StoredChatSession> {
    const revision = 1;
    const { error } = await this.client
      .from(AGENT_SESSION_RECORDS_TABLE)
      .insert(toInsertRow(session, this.userId, revision));

    if (error?.code === "23505") {
      throw new ChatSessionAlreadyExistsError(session.id);
    }
    throwIfSupabaseFailed("create", error);
    return { session, revision };
  }

  async update(input: UpdateChatSessionInput): Promise<StoredChatSession | undefined> {
    const revision = input.expectedRevision + 1;
    const { data, error } = await this.client
      .from(AGENT_SESSION_RECORDS_TABLE)
      .update(toUpdateRow(input.session, revision))
      .eq("session_id", input.session.id)
      .eq("user_id", this.userId)
      .eq("revision", input.expectedRevision)
      .select("revision")
      .maybeSingle();
    throwIfSupabaseFailed("update", error);

    if (data) {
      const persistedRevision = parseRevision(data);
      if (persistedRevision !== revision) {
        throw corruptionError(
          input.session.id,
          `update returned revision ${persistedRevision}; expected ${revision}`
        );
      }
      return { session: input.session, revision: persistedRevision };
    }
    return await this.resolveFailedUpdate(input);
  }

  async delete(input: DeleteChatSessionInput): Promise<boolean> {
    const { data, error } = await this.client
      .from(AGENT_SESSION_RECORDS_TABLE)
      .delete()
      .eq("session_id", input.sessionId)
      .eq("user_id", this.userId)
      .eq("revision", input.expectedRevision)
      .select("revision")
      .maybeSingle();
    throwIfSupabaseFailed("delete", error);

    if (data) {
      return true;
    }

    const actualRevision = await this.readRevision(input.sessionId);
    if (actualRevision === undefined) {
      return false;
    }
    throw new ChatSessionRevisionConflictError(
      input.sessionId,
      input.expectedRevision,
      actualRevision
    );
  }

  private async resolveFailedUpdate(
    input: UpdateChatSessionInput
  ): Promise<StoredChatSession | undefined> {
    const actualRevision = await this.readRevision(input.session.id);
    if (actualRevision === undefined) {
      return undefined;
    }
    throw new ChatSessionRevisionConflictError(
      input.session.id,
      input.expectedRevision,
      actualRevision
    );
  }

  private async readRevision(sessionId: string): Promise<number | undefined> {
    const { data, error } = await this.client
      .from(AGENT_SESSION_RECORDS_TABLE)
      .select("revision")
      .eq("session_id", sessionId)
      .eq("user_id", this.userId)
      .maybeSingle();
    throwIfSupabaseFailed("read revision", error);
    return data ? parseRevision(data) : undefined;
  }
}

function toInsertRow(session: ChatSession, userId: string, revision: number) {
  return {
    session_id: session.id,
    user_id: userId,
    ...toMutableRow(session, revision),
    record_format: RECORD_FORMAT
  };
}

function toUpdateRow(session: ChatSession, revision: number) {
  return toMutableRow(session, revision);
}

function toMutableRow(session: ChatSession, revision: number) {
  return {
    revision,
    name: session.name,
    workspace_id: session.workspaceId ?? null,
    retention: session.retention ?? null,
    pinned: session.pinned,
    archived_at: session.archivedAt ?? null,
    session_created_at: session.createdAt,
    session_updated_at: session.updatedAt,
    catalog: projectCatalogEntry(session, revision),
    record: session
  };
}

function projectCatalogEntry(
  session: ChatSession,
  revision: number
): ChatSessionCatalogEntry {
  const {
    history: _history,
    messages: _messages,
    turns: _turns,
    queuedPrompts: _queuedPrompts,
    ...catalog
  } = session;
  return { ...catalog, revision };
}

function parseCatalogRow(value: unknown): ChatSessionCatalogEntry {
  const row = CatalogRowSchema.safeParse(value);
  if (!row.success) {
    throw corruptionError("catalog row", row.error.message);
  }
  const catalog = CatalogEntrySchema.safeParse(row.data.catalog);
  if (!catalog.success) {
    throw corruptionError(row.data.session_id, catalog.error.message);
  }
  if (
    catalog.data.id !== row.data.session_id
    || catalog.data.revision !== row.data.revision
  ) {
    throw corruptionError(
      row.data.session_id,
      "catalog identity or revision does not match its database row"
    );
  }
  return catalog.data as ChatSessionCatalogEntry;
}

function parseSessionRow(value: unknown): StoredChatSession {
  const row = SessionRowSchema.safeParse(value);
  if (!row.success) {
    throw corruptionError("session row", row.error.message);
  }
  const session = ChatSessionSchema.safeParse(row.data.record);
  if (!session.success) {
    throw corruptionError(row.data.session_id, session.error.message);
  }
  if (session.data.id !== row.data.session_id) {
    throw corruptionError(
      row.data.session_id,
      "record identity does not match its database row"
    );
  }
  return {
    session: session.data as ChatSession,
    revision: row.data.revision
  };
}

function parseRevision(value: unknown): number {
  const parsed = RevisionRowSchema.safeParse(value);
  if (!parsed.success) {
    throw corruptionError("revision row", parsed.error.message);
  }
  return parsed.data.revision;
}

function corruptionError(record: string, detail: string) {
  return new ChatSessionStorageCorruptionError(
    `${AGENT_SESSION_RECORDS_TABLE}/${record}`,
    detail
  );
}

function throwIfSupabaseFailed(
  operation: string,
  error: SupabaseFailure | null
): void {
  if (!error) {
    return;
  }
  const code = error.code ? ` (${error.code})` : "";
  throw new Error(`Supabase chat session ${operation} failed${code}.`, {
    cause: error
  });
}

function validatePageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError(
      "Chat session page limit must be an integer between 1 and 200."
    );
  }
}

function encodeCursor(entry: SessionCursor): string {
  return Buffer.from(JSON.stringify({
    id: entry.id,
    pinned: entry.pinned,
    updatedAt: entry.updatedAt
  }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): SessionCursor {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as unknown;
    if (
      !value
      || typeof value !== "object"
      || !("id" in value)
      || !("pinned" in value)
      || !("updatedAt" in value)
      || typeof value.id !== "string"
      || typeof value.pinned !== "boolean"
      || typeof value.updatedAt !== "string"
    ) {
      throw new InvalidChatSessionCursorError();
    }
    return value as SessionCursor;
  } catch (error) {
    if (error instanceof InvalidChatSessionCursorError) {
      throw error;
    }
    throw new InvalidChatSessionCursorError();
  }
}

function buildCursorFilter(cursor: SessionCursor): string {
  const pinned = `pinned.eq.${cursor.pinned}`;
  const updatedAt = postgrestLiteral(cursor.updatedAt);
  const id = postgrestLiteral(cursor.id);
  const sameTimestamp = `and(${pinned},session_updated_at.eq.${updatedAt},session_id.gt.${id})`;
  const older = `and(${pinned},session_updated_at.lt.${updatedAt})`;
  return cursor.pinned
    ? `${sameTimestamp},${older},pinned.eq.false`
    : `${sameTimestamp},${older}`;
}

function postgrestLiteral(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
