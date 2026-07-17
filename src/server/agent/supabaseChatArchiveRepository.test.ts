import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatArchiveStorageCorruptionError,
  type ChatArchiveManifest,
  type ChatArchiveRecord
} from "@roackb2/heddle";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import { createHeddleChatRepositoryResolver } from "./heddleChatStorage.js";
import { SupabaseChatArchiveRepository } from "./supabaseChatArchiveRepository.js";
import { SupabaseChatSessionRepository } from "./supabaseChatSessionRepository.js";

type RpcArgs = {
  p_session_id: string;
  p_user_id: string;
  p_archive_id: string;
  p_archive_record: ChatArchiveRecord;
  p_messages: unknown[];
  p_summary: string;
  p_created_at: string;
};

type QueryResult = {
  data: unknown;
  error: { code?: string; message: string } | null;
};

test("round-trips archives through fresh repositories without crossing user scope", async () => {
  const database = new InMemoryArchiveDatabase();
  const userA = repository(database, "00000000-0000-4000-8000-00000000000a");
  const result = await userA.append({
    sessionId: "session/with space",
    archive: {
      id: "archive/one",
      messageCount: 2,
      createdAt: "2026-07-17T08:30:00.000Z",
      summaryModel: "gpt-5.4"
    },
    messages: [
      { role: "user", content: "Create a durable deck" },
      { role: "assistant", content: "The deck is ready" }
    ],
    summary: "The user created a durable deck."
  });

  assert.match(
    result.archive.path,
    /^slidex-supabase:\/\/conversation-archive\/session%2Fwith%20space\/archive%2Fone\/messages$/
  );
  assert.equal(database.lastRpcArgs?.p_user_id, "00000000-0000-4000-8000-00000000000a");
  assert.deepEqual(database.lastRpcArgs?.p_archive_record, result.archive);

  const reopenedA = repository(database, "00000000-0000-4000-8000-00000000000a");
  assert.deepEqual(await reopenedA.loadManifest("session/with space"), result.manifest);
  assert.equal(
    await reopenedA.readSummary(result.archive.summaryPath),
    "The user created a durable deck."
  );

  const userB = repository(database, "00000000-0000-4000-8000-00000000000b");
  assert.deepEqual(
    await userB.loadManifest("session/with space"),
    { version: 1, sessionId: "session/with space", archives: [] }
  );
  assert.equal(await userB.readSummary(result.archive.summaryPath), undefined);
  assert.equal(database.unscopedReadCount, 0);
});

test("rejects duplicate or inconsistent appends without advancing the manifest", async () => {
  const database = new InMemoryArchiveDatabase();
  const archives = repository(database, "00000000-0000-4000-8000-00000000000a");
  const input = archiveInput("session-a", "archive-a");
  await archives.append(input);

  await assert.rejects(
    archives.append(input),
    ChatArchiveStorageCorruptionError
  );
  assert.equal(database.archiveCount, 1);
  assert.equal((await archives.loadManifest("session-a")).archives.length, 1);

  database.nextRpcData = {
    version: 1,
    sessionId: "session-b",
    archives: []
  };
  await assert.rejects(
    archives.append(archiveInput("session-b", "archive-b")),
    ChatArchiveStorageCorruptionError
  );
});

test("reports malformed manifests, summary rows, and locators as storage corruption", async () => {
  const database = new InMemoryArchiveDatabase();
  const archives = repository(database, "00000000-0000-4000-8000-00000000000a");
  database.putManifest(
    "00000000-0000-4000-8000-00000000000a",
    "corrupt-session",
    { version: 1, sessionId: "another-session", archives: [] }
  );

  await assert.rejects(
    archives.loadManifest("corrupt-session"),
    ChatArchiveStorageCorruptionError
  );
  database.putSummary(
    "00000000-0000-4000-8000-00000000000a",
    "corrupt-session",
    "archive-a",
    { summary: 42 }
  );
  await assert.rejects(
    archives.readSummary(
      "slidex-supabase://conversation-archive/corrupt-session/archive-a/summary"
    ),
    ChatArchiveStorageCorruptionError
  );
  await assert.rejects(
    archives.readSummary("https://example.com/not-owned"),
    ChatArchiveStorageCorruptionError
  );
});

test("selects file or paired Supabase Heddle repositories once", () => {
  const fileResolver = createHeddleChatRepositoryResolver({
    HEDDLE_SESSION_STORAGE: "file"
  } as Env);
  assert.deepEqual(fileResolver("user-a"), {});

  assert.throws(
    () => createHeddleChatRepositoryResolver({
      HEDDLE_SESSION_STORAGE: "supabase"
    } as Env),
    /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/
  );

  const supabaseResolver = createHeddleChatRepositoryResolver({
    HEDDLE_SESSION_STORAGE: "supabase",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key"
  } as Env);
  const repositories = supabaseResolver("user-a");
  assert.ok(repositories.sessionRepository instanceof SupabaseChatSessionRepository);
  assert.ok(repositories.archiveRepository instanceof SupabaseChatArchiveRepository);
});

function repository(
  database: InMemoryArchiveDatabase,
  userId: string
): SupabaseChatArchiveRepository {
  return new SupabaseChatArchiveRepository(
    database as unknown as SupabaseClient,
    userId
  );
}

function archiveInput(sessionId: string, archiveId: string) {
  return {
    sessionId,
    archive: {
      id: archiveId,
      messageCount: 1,
      createdAt: "2026-07-17T08:30:00.000Z"
    },
    messages: [{ role: "user" as const, content: "Persist this" }],
    summary: "The message was persisted."
  };
}

class InMemoryArchiveDatabase {
  private readonly heads = new Map<string, ChatArchiveManifest>();
  private readonly archives = new Map<string, unknown>();
  lastRpcArgs?: RpcArgs;
  nextRpcData?: unknown;
  unscopedReadCount = 0;

  get archiveCount(): number {
    return this.archives.size;
  }

  from(table: string): InMemoryArchiveQuery {
    assert.ok(
      table === "agent_session_archive_heads"
      || table === "agent_session_archives"
    );
    return new InMemoryArchiveQuery(this, table);
  }

  async rpc(name: string, value: unknown): Promise<QueryResult> {
    await Promise.resolve();
    assert.equal(name, "append_agent_session_archive");
    const args = value as RpcArgs;
    assert.ok(args.p_user_id);
    this.lastRpcArgs = structuredClone(args);

    if (this.nextRpcData !== undefined) {
      const data = this.nextRpcData;
      this.nextRpcData = undefined;
      return { data, error: null };
    }

    const headKey = key(args.p_user_id, args.p_session_id);
    const current = this.heads.get(headKey) ?? {
      version: 1 as const,
      sessionId: args.p_session_id,
      archives: []
    };
    if (current.archives.some(({ id }) => id === args.p_archive_id)) {
      return {
        data: null,
        error: { code: "23505", message: "duplicate archive" }
      };
    }

    const manifest: ChatArchiveManifest = {
      version: 1,
      sessionId: args.p_session_id,
      currentSummaryPath: args.p_archive_record.summaryPath,
      archives: [...current.archives, structuredClone(args.p_archive_record)]
    };
    this.heads.set(headKey, manifest);
    this.archives.set(
      key(args.p_user_id, args.p_session_id, args.p_archive_id),
      { summary: args.p_summary }
    );
    return { data: structuredClone(manifest), error: null };
  }

  putManifest(userId: string, sessionId: string, manifest: ChatArchiveManifest): void {
    this.heads.set(key(userId, sessionId), structuredClone(manifest));
  }

  putSummary(
    userId: string,
    sessionId: string,
    archiveId: string,
    value: unknown
  ): void {
    this.archives.set(key(userId, sessionId, archiveId), structuredClone(value));
  }

  read(
    table: string,
    filters: ReadonlyMap<string, unknown>
  ): QueryResult {
    const userId = filters.get("user_id");
    const sessionId = filters.get("session_id");
    if (typeof userId !== "string") {
      this.unscopedReadCount += 1;
      throw new Error("Archive query omitted its verified user scope");
    }
    if (typeof sessionId !== "string") {
      return { data: null, error: null };
    }
    if (table === "agent_session_archive_heads") {
      const manifest = this.heads.get(key(userId, sessionId));
      return {
        data: manifest ? { manifest: structuredClone(manifest) } : null,
        error: null
      };
    }

    const archiveId = filters.get("archive_id");
    const archive = typeof archiveId === "string"
      ? this.archives.get(key(userId, sessionId, archiveId))
      : undefined;
    return {
      data: archive ? structuredClone(archive) : null,
      error: null
    };
  }
}

class InMemoryArchiveQuery {
  private readonly filters = new Map<string, unknown>();

  constructor(
    private readonly database: InMemoryArchiveDatabase,
    private readonly table: string
  ) {}

  select(_columns: string): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.set(column, value);
    return this;
  }

  async maybeSingle(): Promise<QueryResult> {
    await Promise.resolve();
    return this.database.read(this.table, this.filters);
  }
}

function key(userId: string, sessionId: string, archiveId?: string): string {
  return JSON.stringify([userId, sessionId, archiveId]);
}
