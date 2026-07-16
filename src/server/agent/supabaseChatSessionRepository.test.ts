import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatSessionAlreadyExistsError,
  ChatSessionRevisionConflictError,
  InvalidChatSessionCursorError,
  type ChatSession
} from "@roackb2/heddle";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseChatSessionRepository } from "./supabaseChatSessionRepository.js";

type AgentSessionRecord = {
  session_id: string;
  user_id: string;
  revision: number;
  name: string;
  workspace_id: string | null;
  retention: string | null;
  pinned: boolean;
  archived_at: string | null;
  session_created_at: string;
  session_updated_at: string;
  catalog: unknown;
  record: unknown;
  record_format: number;
};

type QueryResult = {
  data: unknown;
  error: { code?: string; message: string } | null;
};

type Filter = {
  column: keyof AgentSessionRecord;
  kind: "eq" | "is-null" | "not-null";
  value?: unknown;
};

test("round-trips complete Heddle records without crossing the verified user boundary", async () => {
  const database = new InMemoryAgentSessionDatabase();
  const userA = repository(database, "00000000-0000-0000-0000-00000000000a");
  const userB = repository(database, "00000000-0000-0000-0000-00000000000b");
  const original = session("session-a", {
    workspaceId: "presentation-a",
    retention: "reusable",
    model: "gpt-5.4",
    reasoningEffort: "medium",
    context: {
      estimatedHistoryTokens: 42,
      archive: { count: 1, currentSummaryPath: "summary.md" }
    },
    archives: [{
      id: "archive-a",
      path: "archive-a.json",
      summaryPath: "archive-a.md",
      messageCount: 2,
      createdAt: "2026-07-16T00:01:00.000Z"
    }]
  });

  assert.deepEqual(await userA.create(original), { session: original, revision: 1 });
  assert.deepEqual(await userA.read(original.id), { session: original, revision: 1 });
  assert.equal(await userB.read(original.id), undefined);
  assert.equal(await userB.update({ session: original, expectedRevision: 1 }), undefined);
  assert.equal(await userB.delete({ sessionId: original.id, expectedRevision: 1 }), false);
  await assert.rejects(
    userA.create(original),
    ChatSessionAlreadyExistsError
  );
  assert.equal(database.unscopedQueryCount, 0);
});

test("uses atomic expected revisions for update and delete", async () => {
  const database = new InMemoryAgentSessionDatabase();
  const sessions = repository(database, "00000000-0000-0000-0000-00000000000a");
  const original = session("cas-session");
  await sessions.create(original);

  const updated = {
    ...original,
    name: "Updated session",
    updatedAt: "2026-07-16T00:05:00.000Z"
  };
  assert.deepEqual(
    await sessions.update({ session: updated, expectedRevision: 1 }),
    { session: updated, revision: 2 }
  );
  await assert.rejects(
    sessions.update({ session: original, expectedRevision: 1 }),
    ChatSessionRevisionConflictError
  );
  await assert.rejects(
    sessions.delete({ sessionId: original.id, expectedRevision: 1 }),
    ChatSessionRevisionConflictError
  );
  assert.equal(
    await sessions.delete({ sessionId: original.id, expectedRevision: 2 }),
    true
  );
  assert.equal(
    await sessions.delete({ sessionId: original.id, expectedRevision: 2 }),
    false
  );
});

test("lists with Heddle's stable order, opaque cursor, and catalog filters", async () => {
  const database = new InMemoryAgentSessionDatabase();
  const sessions = repository(database, "00000000-0000-0000-0000-00000000000a");
  await Promise.all([
    sessions.create(session("pinned-a", {
      pinned: true,
      workspaceId: "presentation-a",
      updatedAt: "2026-07-16T00:05:00.000Z"
    })),
    sessions.create(session("pinned-b", {
      pinned: true,
      workspaceId: "presentation-a",
      updatedAt: "2026-07-16T00:04:00.000Z"
    })),
    sessions.create(session("recent", {
      workspaceId: "presentation-a",
      updatedAt: "2026-07-16T00:06:00.000Z"
    })),
    sessions.create(session("same-a", {
      workspaceId: "presentation-b",
      updatedAt: "2026-07-16T00:03:00.000Z"
    })),
    sessions.create(session("same-b", {
      workspaceId: "presentation-b",
      updatedAt: "2026-07-16T00:03:00.000Z",
      archivedAt: "2026-07-16T00:07:00.000Z"
    }))
  ]);

  const first = await sessions.list({ limit: 2 });
  assert.deepEqual(first.items.map(({ id }) => id), ["pinned-a", "pinned-b"]);
  assert.ok(first.nextCursor);
  const second = await sessions.list({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(({ id }) => id), ["recent", "same-a"]);
  assert.ok(second.nextCursor);
  const third = await sessions.list({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.items.map(({ id }) => id), ["same-b"]);
  assert.equal(third.nextCursor, undefined);

  assert.deepEqual(
    (await sessions.list({
      limit: 10,
      workspaceId: "presentation-a",
      archived: false
    })).items.map(({ id }) => id),
    ["pinned-a", "pinned-b", "recent"]
  );
  assert.deepEqual(
    (await sessions.list({ limit: 10, archived: true })).items.map(({ id }) => id),
    ["same-b"]
  );
  await assert.rejects(
    sessions.list({ limit: 2, cursor: "not-a-cursor" }),
    InvalidChatSessionCursorError
  );
});

function repository(
  database: InMemoryAgentSessionDatabase,
  userId: string
): SupabaseChatSessionRepository {
  return new SupabaseChatSessionRepository(
    database as unknown as SupabaseClient,
    userId
  );
}

function session(
  id: string,
  overrides: Partial<ChatSession> = {}
): ChatSession {
  return {
    id,
    name: `Session ${id}`,
    pinned: false,
    history: [
      { role: "user", content: "Create a durable deck" },
      { role: "assistant", content: "The deck is ready." }
    ],
    messages: [
      { id: `${id}-user`, role: "user", text: "Create a durable deck" },
      { id: `${id}-assistant`, role: "assistant", text: "The deck is ready." }
    ],
    turns: [{
      id: `${id}-turn`,
      prompt: "Create a durable deck",
      outcome: "done",
      summary: "The deck is ready.",
      steps: 2,
      traceFile: `${id}.jsonl`,
      events: ["turn.completed"]
    }],
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:01:00.000Z",
    queuedPrompts: [{
      id: `${id}-queued`,
      prompt: "Tighten the conclusion",
      createdAt: "2026-07-16T00:01:00.000Z",
      updatedAt: "2026-07-16T00:01:00.000Z"
    }],
    ...overrides
  };
}

class InMemoryAgentSessionDatabase {
  readonly rows = new Map<string, AgentSessionRecord>();
  unscopedQueryCount = 0;

  from(table: string): InMemoryQuery {
    assert.equal(table, "agent_session_records");
    return new InMemoryQuery(this);
  }
}

class InMemoryQuery implements PromiseLike<QueryResult> {
  private operation: "select" | "insert" | "update" | "delete" = "select";
  private payload?: Partial<AgentSessionRecord>;
  private readonly filters: Filter[] = [];
  private cursorFilter?: string;
  private rowLimit?: number;

  constructor(private readonly database: InMemoryAgentSessionDatabase) {}

  select(_columns: string): this {
    return this;
  }

  insert(row: AgentSessionRecord): this {
    this.operation = "insert";
    this.payload = row;
    return this;
  }

  update(row: Partial<AgentSessionRecord>): this {
    this.operation = "update";
    this.payload = row;
    return this;
  }

  delete(): this {
    this.operation = "delete";
    return this;
  }

  eq(column: keyof AgentSessionRecord, value: unknown): this {
    this.filters.push({ column, kind: "eq", value });
    return this;
  }

  is(column: keyof AgentSessionRecord, value: null): this {
    assert.equal(value, null);
    this.filters.push({ column, kind: "is-null" });
    return this;
  }

  not(column: keyof AgentSessionRecord, operator: "is", value: null): this {
    assert.equal(operator, "is");
    assert.equal(value, null);
    this.filters.push({ column, kind: "not-null" });
    return this;
  }

  or(filter: string): this {
    this.cursorFilter = filter;
    return this;
  }

  order(_column: keyof AgentSessionRecord, _options: { ascending: boolean }): this {
    return this;
  }

  limit(limit: number): this {
    this.rowLimit = limit;
    return this;
  }

  maybeSingle(): Promise<QueryResult> {
    return this.execute().then((result) => {
      const rows = Array.isArray(result.data) ? result.data : [];
      return { ...result, data: rows[0] ?? null };
    });
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<QueryResult> {
    await Promise.resolve();
    if (this.operation === "insert") {
      return this.executeInsert();
    }

    this.assertUserScope();
    const matched = [...this.database.rows.values()].filter((row) => (
      this.matchesFilters(row) && this.matchesCursor(row)
    ));
    if (this.operation === "update") {
      return this.executeUpdate(matched);
    }
    if (this.operation === "delete") {
      return this.executeDelete(matched);
    }

    const ordered = matched.sort(compareRows);
    return {
      data: this.rowLimit === undefined
        ? ordered
        : ordered.slice(0, this.rowLimit),
      error: null
    };
  }

  private executeInsert(): QueryResult {
    const row = this.payload as AgentSessionRecord | undefined;
    if (!row?.user_id) {
      this.database.unscopedQueryCount += 1;
      throw new Error("Insert omitted its verified user scope");
    }
    if (this.database.rows.has(row.session_id)) {
      return {
        data: null,
        error: { code: "23505", message: "duplicate key" }
      };
    }
    this.database.rows.set(row.session_id, structuredClone(row));
    return { data: null, error: null };
  }

  private executeUpdate(rows: AgentSessionRecord[]): QueryResult {
    const updated = rows.map((row) => {
      const next = { ...row, ...structuredClone(this.payload ?? {}) };
      this.database.rows.set(next.session_id, next);
      return next;
    });
    return { data: updated, error: null };
  }

  private executeDelete(rows: AgentSessionRecord[]): QueryResult {
    rows.forEach((row) => this.database.rows.delete(row.session_id));
    return { data: rows, error: null };
  }

  private assertUserScope(): void {
    if (!this.filters.some(({ column, kind }) => (
      column === "user_id" && kind === "eq"
    ))) {
      this.database.unscopedQueryCount += 1;
      throw new Error("Query omitted its verified user scope");
    }
  }

  private matchesFilters(row: AgentSessionRecord): boolean {
    return this.filters.every((filter) => {
      if (filter.kind === "is-null") {
        return row[filter.column] === null;
      }
      if (filter.kind === "not-null") {
        return row[filter.column] !== null;
      }
      return row[filter.column] === filter.value;
    });
  }

  private matchesCursor(row: AgentSessionRecord): boolean {
    if (!this.cursorFilter) {
      return true;
    }
    const pinned = this.cursorFilter.includes("pinned.eq.true");
    const updatedAt = captureLiteral(
      this.cursorFilter,
      /session_updated_at\.eq\."([^"]+)"/
    );
    const id = captureLiteral(this.cursorFilter, /session_id\.gt\."([^"]+)"/);
    return (
      row.pinned === pinned
      && row.session_updated_at === updatedAt
      && row.session_id > id
    ) || (
      row.pinned === pinned
      && row.session_updated_at < updatedAt
    ) || (
      pinned && row.pinned === false
    );
  }
}

function captureLiteral(value: string, pattern: RegExp): string {
  const match = pattern.exec(value);
  assert.ok(match?.[1], `Expected ${pattern} in ${value}`);
  return match[1];
}

function compareRows(left: AgentSessionRecord, right: AgentSessionRecord): number {
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }
  return right.session_updated_at.localeCompare(left.session_updated_at)
    || left.session_id.localeCompare(right.session_id);
}
