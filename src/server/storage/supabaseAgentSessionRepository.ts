import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  AgentSessionPage,
  AgentSessionSummary,
  ChatMessage,
  Session
} from "../../shared/schema.js";
import type { Env } from "../env.js";
import {
  AgentSessionIdempotencyConflictError,
  AgentSessionPresentationConflictError,
  compareAgentSessionsNewestFirst,
  decodeAgentSessionCursor,
  encodeAgentSessionCursor,
  type AgentSessionRepository,
  type AppendAgentSessionMessageInput,
  type CreateAgentSessionInput
} from "./agentSessionRepository.js";

const AGENT_SESSIONS_TABLE = "agent_sessions";
const AGENT_SESSION_MESSAGES_TABLE = "agent_session_messages";
const PRESENTATIONS_TABLE = "presentations";
const APPEND_MESSAGE_RPC = "append_agent_session_message";
const TimestampSchema = z.string().datetime({ offset: true }).transform((value) => (
  new Date(value).toISOString()
));

const AgentSessionRowSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  presentation_id: z.string().min(1),
  title: z.string().min(1),
  message_count: z.number().int().nonnegative(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema
});

const PresentationRowSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  title: z.string().min(1),
  source: z.string()
});

const AgentSessionMessageRowSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  user_id: z.string().min(1),
  run_id: z.string().min(1),
  kind: z.enum(["user_input", "assistant_terminal"]),
  role: z.enum(["user", "assistant"]),
  ordinal: z.number().int().positive(),
  content: z.string(),
  metadata: z.record(z.unknown()),
  created_at: TimestampSchema
});

const AgentSessionIdRowSchema = z.object({ id: z.string().min(1) });

type AgentSessionRow = z.infer<typeof AgentSessionRowSchema>;
type PresentationRow = z.infer<typeof PresentationRowSchema>;
type SupabaseFailure = { code?: string; message?: string };

export class SupabaseAgentSessionStorageError extends Error {
  constructor(operation: string) {
    super(`Supabase product conversation storage failed during ${operation}`);
    this.name = "SupabaseAgentSessionStorageError";
  }
}

/**
 * SlideX product-session adapter for the browser-safe catalog and transcript.
 *
 * The service role bypasses RLS, so every read and mutation is explicitly
 * constrained by the verified user ID. Heddle's opaque ChatSession record is
 * stored through a separate repository and is never projected here.
 */
export class SupabaseAgentSessionRepository implements AgentSessionRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listAgentSessions(
    userId: string,
    input: { limit: number; cursor?: string }
  ): Promise<AgentSessionPage> {
    const cursor = input.cursor ? decodeAgentSessionCursor(input.cursor) : undefined;
    const rows = await this.readSessionPage(userId, input.limit, cursor);
    const visible = rows.slice(0, input.limit);
    const presentations = await this.readPresentations(
      userId,
      visible.map(({ presentation_id }) => presentation_id)
    );
    const items = visible.map((row) => toSummary(row, requirePresentation(
      presentations,
      row.presentation_id
    )));
    const last = items.at(-1);

    return {
      items,
      ...(rows.length > input.limit && last
        ? { nextCursor: encodeAgentSessionCursor({
            id: last.id,
            lastActivityAt: last.lastActivityAt
          }) }
        : {})
    };
  }

  async createSession(input: CreateAgentSessionInput): Promise<Session> {
    if (!input.presentationId) {
      throw new TypeError("Supabase product conversations require a presentation ID.");
    }
    await this.requirePresentation(input.userId, input.presentationId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = nanoid();
      const { data, error } = await this.client
        .from(AGENT_SESSIONS_TABLE)
        .insert({
          id,
          user_id: input.userId,
          presentation_id: input.presentationId,
          title: input.title ?? "Untitled deck",
          message_count: 0
        })
        .select(sessionColumns)
        .single();

      if (error?.code === "23505") {
        continue;
      }
      throwIfSupabaseFailed("create conversation", error);
      const row = parseSessionRow(data);
      return this.hydrateSession(input.userId, row);
    }
    throw new SupabaseAgentSessionStorageError("allocate conversation ID");
  }

  async getSession(userId: string, sessionId: string): Promise<Session | null> {
    const row = await this.readSessionRow(userId, sessionId);
    return row ? this.hydrateSession(userId, row) : null;
  }

  async attachSessionToPresentation(
    userId: string,
    sessionId: string,
    input: { presentationId: string; presentationTitle: string }
  ): Promise<Session | null> {
    const row = await this.readSessionRow(userId, sessionId);
    if (!row) {
      return null;
    }
    if (row.presentation_id !== input.presentationId) {
      throw new AgentSessionPresentationConflictError();
    }
    return this.hydrateSession(userId, row);
  }

  async appendRunMessage(input: AppendAgentSessionMessageInput): Promise<Session | null> {
    const { error } = await this.client.rpc(APPEND_MESSAGE_RPC, {
      p_session_id: input.sessionId,
      p_user_id: input.userId,
      p_run_id: input.runId,
      p_kind: input.kind,
      p_role: input.role,
      p_content: input.content,
      p_metadata: input.metadata ?? {}
    });
    if (error?.code === "P0002") {
      return null;
    }
    if (error?.code === "23505") {
      throw new AgentSessionIdempotencyConflictError(
        input.sessionId,
        input.runId,
        input.kind
      );
    }
    throwIfSupabaseFailed("append conversation message", error);

    const session = await this.getSession(input.userId, input.sessionId);
    if (!session) {
      throw new SupabaseAgentSessionStorageError("hydrate appended conversation");
    }
    return session;
  }

  async deleteSession(userId: string, sessionId: string): Promise<{ ok: true }> {
    const first = await this.deleteSessionRow(userId, sessionId);
    // The delete is owner-scoped and idempotent. Retrying once safely covers
    // both a transient failure and a lost response after a committed cascade.
    const { data, error } = first.error
      ? await this.deleteSessionRow(userId, sessionId)
      : first;
    throwIfSupabaseFailed("delete conversation", error);
    if (data) {
      AgentSessionIdRowSchema.parse(data);
    }
    return { ok: true };
  }

  private deleteSessionRow(userId: string, sessionId: string) {
    return this.client
      .from(AGENT_SESSIONS_TABLE)
      .delete()
      .eq("id", sessionId)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();
  }

  private async readSessionPage(
    userId: string,
    limit: number,
    cursor?: { id: string; lastActivityAt: string }
  ): Promise<AgentSessionRow[]> {
    if (!cursor) {
      const { data, error } = await this.sessionPageQuery(userId)
        .limit(limit + 1);
      throwIfSupabaseFailed("list conversations", error);
      return parseSessionRows(data);
    }

    const [sameTimestampResult, olderResult] = await Promise.all([
      this.sessionPageQuery(userId)
        .eq("updated_at", cursor.lastActivityAt)
        .lt("id", cursor.id)
        .limit(limit + 1),
      this.sessionPageQuery(userId)
        .lt("updated_at", cursor.lastActivityAt)
        .limit(limit + 1)
    ]);
    throwIfSupabaseFailed("list conversations at cursor", sameTimestampResult.error);
    throwIfSupabaseFailed("list conversations after cursor", olderResult.error);
    return [
      ...parseSessionRows(sameTimestampResult.data),
      ...parseSessionRows(olderResult.data)
    ]
      .sort((left, right) => compareAgentSessionsNewestFirst(
        { id: left.id, lastActivityAt: left.updated_at },
        { id: right.id, lastActivityAt: right.updated_at }
      ))
      .slice(0, limit + 1);
  }

  private sessionPageQuery(userId: string) {
    return this.client
      .from(AGENT_SESSIONS_TABLE)
      .select(sessionColumns)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false });
  }

  private async readSessionRow(
    userId: string,
    sessionId: string
  ): Promise<AgentSessionRow | null> {
    const { data, error } = await this.client
      .from(AGENT_SESSIONS_TABLE)
      .select(sessionColumns)
      .eq("id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();
    throwIfSupabaseFailed("read conversation", error);
    return data ? parseSessionRow(data) : null;
  }

  private async hydrateSession(userId: string, row: AgentSessionRow): Promise<Session> {
    const [presentation, messages] = await Promise.all([
      this.requirePresentation(userId, row.presentation_id),
      this.readMessages(userId, row.id)
    ]);
    if (row.message_count !== messages.length) {
      throw new SupabaseAgentSessionStorageError("validate conversation message count");
    }
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      presentationId: row.presentation_id,
      presentationTitle: presentation.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      latestMotionDoc: presentation.source,
      messages
    };
  }

  private async readMessages(userId: string, sessionId: string): Promise<ChatMessage[]> {
    const { data, error } = await this.client
      .from(AGENT_SESSION_MESSAGES_TABLE)
      .select(messageColumns)
      .eq("session_id", sessionId)
      .eq("user_id", userId)
      .order("ordinal", { ascending: true });
    throwIfSupabaseFailed("read conversation messages", error);
    return (data ?? []).map((value) => {
      const row = AgentSessionMessageRowSchema.parse(value);
      return {
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
        metadata: {
          ...row.metadata,
          runId: row.run_id,
          kind: row.kind
        }
      };
    });
  }

  private async requirePresentation(
    userId: string,
    presentationId: string
  ): Promise<PresentationRow> {
    const { data, error } = await this.client
      .from(PRESENTATIONS_TABLE)
      .select(presentationColumns)
      .eq("id", presentationId)
      .eq("user_id", userId)
      .maybeSingle();
    throwIfSupabaseFailed("read presentation", error);
    if (!data) {
      throw new AgentSessionPresentationConflictError();
    }
    return PresentationRowSchema.parse(data);
  }

  private async readPresentations(
    userId: string,
    presentationIds: string[]
  ): Promise<Map<string, PresentationRow>> {
    const ids = [...new Set(presentationIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const { data, error } = await this.client
      .from(PRESENTATIONS_TABLE)
      .select(presentationColumns)
      .eq("user_id", userId)
      .in("id", ids);
    throwIfSupabaseFailed("read conversation presentations", error);
    return new Map((data ?? []).map((value) => {
      const row = PresentationRowSchema.parse(value);
      return [row.id, row];
    }));
  }
}

export function createAgentSessionRepository(
  env: Env,
  fileRepository: AgentSessionRepository
): AgentSessionRepository {
  if (env.SLIDEX_PRODUCT_SESSION_STORAGE === "file") {
    return fileRepository;
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase product conversation storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
  return new SupabaseAgentSessionRepository(client);
}

const sessionColumns = [
  "id",
  "user_id",
  "presentation_id",
  "title",
  "message_count",
  "created_at",
  "updated_at"
].join(",");

const presentationColumns = "id,user_id,title,source";

const messageColumns = [
  "id",
  "session_id",
  "user_id",
  "run_id",
  "kind",
  "role",
  "ordinal",
  "content",
  "metadata",
  "created_at"
].join(",");

function toSummary(
  session: AgentSessionRow,
  presentation: PresentationRow
): AgentSessionSummary {
  return {
    id: session.id,
    title: session.title,
    presentation: {
      id: presentation.id,
      title: presentation.title
    },
    createdAt: session.created_at,
    lastActivityAt: session.updated_at,
    messageCount: session.message_count
  };
}

function parseSessionRow(value: unknown): AgentSessionRow {
  const result = AgentSessionRowSchema.safeParse(value);
  if (!result.success) {
    throw new SupabaseAgentSessionStorageError("validate conversation row");
  }
  return result.data;
}

function parseSessionRows(value: unknown): AgentSessionRow[] {
  const result = z.array(AgentSessionRowSchema).safeParse(value ?? []);
  if (!result.success) {
    throw new SupabaseAgentSessionStorageError("validate conversation rows");
  }
  return result.data;
}

function requirePresentation(
  presentations: Map<string, PresentationRow>,
  presentationId: string
): PresentationRow {
  const presentation = presentations.get(presentationId);
  if (!presentation) {
    throw new SupabaseAgentSessionStorageError("join conversation presentation");
  }
  return presentation;
}

function throwIfSupabaseFailed(operation: string, error: SupabaseFailure | null): void {
  if (error) {
    throw new SupabaseAgentSessionStorageError(operation);
  }
}
