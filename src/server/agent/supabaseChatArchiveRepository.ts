import { isDeepStrictEqual } from "node:util";
import {
  ChatArchivePersistenceCodec,
  ChatArchiveStorageCorruptionError,
  type AppendChatArchiveInput,
  type AppendChatArchiveResult,
  type ChatArchiveManifest,
  type ChatArchiveRecord,
  type ChatArchiveRepository
} from "@roackb2/heddle";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const AGENT_SESSION_ARCHIVES_TABLE = "agent_session_archives";
const AGENT_SESSION_ARCHIVE_HEADS_TABLE = "agent_session_archive_heads";
const APPEND_AGENT_SESSION_ARCHIVE_RPC = "append_agent_session_archive";
const LOCATOR_PROTOCOL = "slidex-supabase:";
const LOCATOR_HOST = "conversation-archive";

const ManifestRowSchema = z.object({ manifest: z.unknown() });
const SummaryRowSchema = z.object({ summary: z.string() });

type SummaryAddress = {
  sessionId: string;
  archiveId: string;
};

type SupabaseFailure = {
  code?: string;
  message?: string;
};

/**
 * Supabase implementation of Heddle's append-only compaction archive port.
 *
 * The repository is bound to one verified SlideX user. Opaque locators address
 * content but never select authorization scope; every read and append retains
 * the constructor-provided user ID.
 */
export class SupabaseChatArchiveRepository implements ChatArchiveRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly userId: string
  ) {
    if (!userId.trim()) {
      throw new TypeError("Supabase chat archive repositories require a verified user ID.");
    }
  }

  async loadManifest(sessionId: string): Promise<ChatArchiveManifest> {
    const { data, error } = await this.client
      .from(AGENT_SESSION_ARCHIVE_HEADS_TABLE)
      .select("manifest")
      .eq("session_id", sessionId)
      .eq("user_id", this.userId)
      .maybeSingle();
    throwIfSupabaseFailed("load manifest", error);

    if (!data) {
      return ChatArchivePersistenceCodec.emptyManifest(sessionId);
    }
    const row = ManifestRowSchema.safeParse(data);
    if (!row.success) {
      throw corruptionError(manifestLocator(sessionId), row.error.message);
    }
    return parseManifest(row.data.manifest, sessionId);
  }

  async readSummary(summaryLocator: string): Promise<string | undefined> {
    const address = parseSummaryLocator(summaryLocator);
    const { data, error } = await this.client
      .from(AGENT_SESSION_ARCHIVES_TABLE)
      .select("summary")
      .eq("session_id", address.sessionId)
      .eq("user_id", this.userId)
      .eq("archive_id", address.archiveId)
      .maybeSingle();
    throwIfSupabaseFailed("read summary", error);

    if (!data) {
      return undefined;
    }
    const row = SummaryRowSchema.safeParse(data);
    if (!row.success) {
      throw corruptionError(summaryLocator, row.error.message);
    }
    return row.data.summary;
  }

  async append(input: AppendChatArchiveInput): Promise<AppendChatArchiveResult> {
    const archive = toPersistedArchiveRecord(input);
    const { data, error } = await this.client.rpc(
      APPEND_AGENT_SESSION_ARCHIVE_RPC,
      {
        p_session_id: input.sessionId,
        p_user_id: this.userId,
        p_archive_id: archive.id,
        p_archive_record: archive,
        p_messages: input.messages,
        p_summary: input.summary,
        p_created_at: archive.createdAt
      }
    );

    if (error?.code === "23505") {
      throw corruptionError(
        manifestLocator(input.sessionId),
        `archive ${archive.id} already exists outside the current manifest`
      );
    }
    throwIfSupabaseFailed("append", error);

    const manifest = parseManifest(data, input.sessionId);
    const appended = manifest.archives.at(-1);
    if (!appended || !isDeepStrictEqual(appended, archive)) {
      throw corruptionError(
        manifestLocator(input.sessionId),
        `append response did not end with archive ${archive.id}`
      );
    }
    return { archive, manifest };
  }
}

function toPersistedArchiveRecord(input: AppendChatArchiveInput): ChatArchiveRecord {
  const candidate = {
    ...input.archive,
    path: archiveLocator(input.sessionId, input.archive.id, "messages"),
    summaryPath: archiveLocator(input.sessionId, input.archive.id, "summary")
  };
  const validated = ChatArchivePersistenceCodec.appendArchive(
    ChatArchivePersistenceCodec.emptyManifest(input.sessionId),
    candidate
  ).archives[0];
  if (!validated) {
    throw new Error("Heddle archive validation did not return the appended record.");
  }

  // Supabase persists JSON. Normalize optional undefined fields through the
  // same JSON boundary so the returned record exactly matches PostgreSQL JSONB.
  return JSON.parse(JSON.stringify(validated)) as ChatArchiveRecord;
}

function parseManifest(value: unknown, sessionId: string): ChatArchiveManifest {
  try {
    return ChatArchivePersistenceCodec.parseManifest(value, sessionId);
  } catch (error) {
    if (error instanceof ChatArchiveStorageCorruptionError) {
      throw error;
    }
    throw corruptionError(manifestLocator(sessionId), errorDetail(error));
  }
}

function archiveLocator(
  sessionId: string,
  archiveId: string,
  content: "messages" | "summary"
): string {
  return `${LOCATOR_PROTOCOL}//${LOCATOR_HOST}/${encodeURIComponent(sessionId)}/${encodeURIComponent(archiveId)}/${content}`;
}

function manifestLocator(sessionId: string): string {
  return `${LOCATOR_PROTOCOL}//${LOCATOR_HOST}/${encodeURIComponent(sessionId)}/manifest`;
}

function parseSummaryLocator(locator: string): SummaryAddress {
  try {
    const url = new URL(locator);
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const [sessionId, archiveId, content] = segments;
    const valid = url.protocol === LOCATOR_PROTOCOL
      && url.hostname === LOCATOR_HOST
      && url.username === ""
      && url.password === ""
      && url.port === ""
      && url.search === ""
      && url.hash === ""
      && segments.length === 3
      && Boolean(sessionId)
      && Boolean(archiveId)
      && content === "summary";
    if (!valid || !sessionId || !archiveId) {
      throw new Error("expected a repository-owned summary locator");
    }
    return { sessionId, archiveId };
  } catch (error) {
    throw corruptionError(locator, errorDetail(error));
  }
}

function corruptionError(locator: string, detail: string) {
  return new ChatArchiveStorageCorruptionError(locator, detail);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfSupabaseFailed(
  operation: string,
  error: SupabaseFailure | null
): void {
  if (!error) {
    return;
  }
  const code = error.code ? ` (${error.code})` : "";
  throw new Error(`Supabase chat archive ${operation} failed${code}.`, {
    cause: error
  });
}
