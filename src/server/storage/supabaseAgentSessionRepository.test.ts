import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AgentSessionIdempotencyConflictError,
  AgentSessionPresentationConflictError
} from "./agentSessionRepository.js";
import { SupabaseAgentSessionRepository } from "./supabaseAgentSessionRepository.js";

type ProductSessionRow = {
  id: string;
  user_id: string;
  presentation_id: string;
  title: string;
  message_count: number;
  created_at: string;
  updated_at: string;
};

type PresentationRow = {
  id: string;
  user_id: string;
  title: string;
  source: string;
};

type ProductMessageRow = {
  id: string;
  session_id: string;
  user_id: string;
  run_id: string;
  kind: "user_input" | "assistant_terminal";
  role: "user" | "assistant";
  ordinal: number;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type DatabaseRow = ProductSessionRow | PresentationRow | ProductMessageRow;

type QueryResult = {
  data: unknown;
  error: { code?: string; message: string } | null;
};

type Filter = {
  column: string;
  kind: "eq" | "lt" | "in";
  value: unknown;
};

test("persists a user-scoped durable transcript with retry-safe messages", async () => {
  const database = new InMemoryProductSessionDatabase();
  const userA = "00000000-0000-0000-0000-00000000000a";
  const userB = "00000000-0000-0000-0000-00000000000b";
  database.presentations.set("presentation-a", presentation("presentation-a", userA));
  database.presentations.set("presentation-b", presentation("presentation-b", userB));
  const repository = productRepository(database);

  const created = await repository.createSession({
    userId: userA,
    presentationId: "presentation-a",
    title: "Durable deck"
  });
  assert.equal(created.latestMotionDoc, "# presentation-a");
  assert.deepEqual(created.messages, []);
  assert.equal(await repository.getSession(userB, created.id), null);

  const accepted = {
    userId: userA,
    sessionId: created.id,
    runId: "run-a",
    kind: "user_input" as const,
    role: "user" as const,
    content: "Make the title clearer"
  };
  await repository.appendRunMessage(accepted);
  await repository.appendRunMessage(accepted);
  await repository.appendRunMessage({
    userId: userA,
    sessionId: created.id,
    runId: "run-a",
    kind: "assistant_terminal",
    role: "assistant",
    content: "Updated the title. Validation passed.",
    metadata: { outcome: "complete" }
  });

  const hydrated = await repository.getSession(userA, created.id);
  assert.deepEqual(hydrated?.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "Make the title clearer" },
    { role: "assistant", content: "Updated the title. Validation passed." }
  ]);
  assert.equal(hydrated?.messages[1]?.metadata?.outcome, "complete");
  assert.equal(database.messages.length, 2);

  await assert.rejects(
    repository.appendRunMessage({ ...accepted, content: "Changed retry body" }),
    AgentSessionIdempotencyConflictError
  );
  assert.deepEqual(await repository.deleteSession(userB, created.id), { ok: true });
  assert.ok(await repository.getSession(userA, created.id));
  database.deleteFailuresRemaining = 1;
  assert.deepEqual(await repository.deleteSession(userA, created.id), { ok: true });
  assert.equal(database.deleteAttempts, 3);
  assert.equal(await repository.getSession(userA, created.id), null);
  assert.equal(database.messages.length, 0);
  assert.equal(database.unscopedQueryCount, 0);
});

test("uses stable catalog pagination and immutable presentation ownership", async () => {
  const database = new InMemoryProductSessionDatabase();
  const userId = "00000000-0000-0000-0000-00000000000a";
  const otherUserId = "00000000-0000-0000-0000-00000000000b";
  database.presentations.set("presentation-a", presentation("presentation-a", userId));
  database.presentations.set(
    "presentation-other",
    presentation("presentation-other", otherUserId)
  );
  database.sessions.set("session-a", productSession("session-a", userId, {
    updated_at: "2026-07-16T00:02:00.000Z"
  }));
  database.sessions.set("session-b", productSession("session-b", userId, {
    updated_at: "2026-07-16T00:02:00.000Z"
  }));
  database.sessions.set("session-old", productSession("session-old", userId, {
    updated_at: "2026-07-16T00:01:00.000Z"
  }));
  const repository = productRepository(database);

  const first = await repository.listAgentSessions(userId, { limit: 1 });
  assert.deepEqual(first.items.map(({ id }) => id), ["session-b"]);
  assert.equal(first.items[0]?.createdAt, "2026-07-16T00:00:00.000Z");
  assert.ok(first.nextCursor);
  const second = await repository.listAgentSessions(userId, {
    limit: 1,
    cursor: first.nextCursor
  });
  assert.deepEqual(second.items.map(({ id }) => id), ["session-a"]);
  assert.ok(second.nextCursor);
  const third = await repository.listAgentSessions(userId, {
    limit: 1,
    cursor: second.nextCursor
  });
  assert.deepEqual(third.items.map(({ id }) => id), ["session-old"]);
  assert.equal(third.nextCursor, undefined);

  await assert.rejects(
    repository.createSession({
      userId,
      presentationId: "presentation-other",
      title: "Wrong owner"
    }),
    AgentSessionPresentationConflictError
  );
  await assert.rejects(
    repository.attachSessionToPresentation(userId, "session-a", {
      presentationId: "presentation-other",
      presentationTitle: "Other deck"
    }),
    AgentSessionPresentationConflictError
  );
  assert.equal(database.unscopedQueryCount, 0);
});

function productRepository(
  database: InMemoryProductSessionDatabase
): SupabaseAgentSessionRepository {
  return new SupabaseAgentSessionRepository(
    database as unknown as SupabaseClient
  );
}

function presentation(id: string, userId: string): PresentationRow {
  return {
    id,
    user_id: userId,
    title: `Deck ${id}`,
    source: `# ${id}`
  };
}

function productSession(
  id: string,
  userId: string,
  overrides: Partial<ProductSessionRow> = {}
): ProductSessionRow {
  return {
    id,
    user_id: userId,
    presentation_id: "presentation-a",
    title: `Conversation ${id}`,
    message_count: 0,
    // Supabase/PostgreSQL returns timezone offsets rather than always using Z.
    created_at: "2026-07-16T00:00:00.000000+00:00",
    updated_at: "2026-07-16T00:00:00.000000+00:00",
    ...overrides
  };
}

class InMemoryProductSessionDatabase {
  readonly sessions = new Map<string, ProductSessionRow>();
  readonly presentations = new Map<string, PresentationRow>();
  readonly messages: ProductMessageRow[] = [];
  unscopedQueryCount = 0;
  deleteAttempts = 0;
  deleteFailuresRemaining = 0;
  private timestamp = Date.parse("2026-07-16T00:10:00.000Z");

  from(table: string): InMemoryProductQuery {
    assert.ok([
      "agent_sessions",
      "presentations",
      "agent_session_messages"
    ].includes(table));
    return new InMemoryProductQuery(this, table);
  }

  async rpc(name: string, input: Record<string, unknown>): Promise<QueryResult> {
    assert.equal(name, "append_agent_session_message");
    const userId = input.p_user_id;
    if (typeof userId !== "string") {
      this.unscopedQueryCount += 1;
      throw new Error("RPC omitted its verified user scope");
    }
    const sessionId = String(input.p_session_id);
    const runId = String(input.p_run_id);
    const kind = input.p_kind as ProductMessageRow["kind"];
    const role = input.p_role as ProductMessageRow["role"];
    const content = String(input.p_content);
    const metadata = input.p_metadata as Record<string, unknown>;
    const parent = this.sessions.get(sessionId);
    if (!parent || parent.user_id !== userId) {
      return { data: null, error: { code: "P0002", message: "missing parent" } };
    }

    const existing = this.messages.find((message) => (
      message.session_id === sessionId
      && message.user_id === userId
      && message.run_id === runId
      && message.kind === kind
    ));
    if (existing) {
      return existing.role === role
        && existing.content === content
        && JSON.stringify(existing.metadata) === JSON.stringify(metadata)
        ? { data: structuredClone(existing), error: null }
        : { data: null, error: { code: "23505", message: "changed retry" } };
    }

    const ordinal = this.messages
      .filter((message) => message.session_id === sessionId && message.user_id === userId)
      .reduce((maximum, message) => Math.max(maximum, message.ordinal), 0) + 1;
    const createdAt = this.nextTimestamp();
    const message: ProductMessageRow = {
      id: `message-${this.messages.length + 1}`,
      session_id: sessionId,
      user_id: userId,
      run_id: runId,
      kind,
      role,
      ordinal,
      content,
      metadata: structuredClone(metadata),
      created_at: createdAt
    };
    this.messages.push(message);
    this.sessions.set(sessionId, {
      ...parent,
      message_count: parent.message_count + 1,
      updated_at: createdAt
    });
    return { data: structuredClone(message), error: null };
  }

  rows(table: string): DatabaseRow[] {
    if (table === "agent_sessions") {
      return [...this.sessions.values()];
    }
    if (table === "presentations") {
      return [...this.presentations.values()];
    }
    return this.messages;
  }

  nextTimestamp(): string {
    this.timestamp += 1_000;
    return new Date(this.timestamp).toISOString();
  }
}

class InMemoryProductQuery implements PromiseLike<QueryResult> {
  private operation: "select" | "insert" | "delete" = "select";
  private payload?: Record<string, unknown>;
  private readonly filters: Filter[] = [];
  private readonly orders: Array<{ column: string; ascending: boolean }> = [];
  private rowLimit?: number;

  constructor(
    private readonly database: InMemoryProductSessionDatabase,
    private readonly table: string
  ) {}

  select(_columns: string): this {
    return this;
  }

  insert(row: Record<string, unknown>): this {
    this.operation = "insert";
    this.payload = row;
    return this;
  }

  delete(): this {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, kind: "eq", value });
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filters.push({ column, kind: "lt", value });
    return this;
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ column, kind: "in", value });
    return this;
  }

  order(column: string, options: { ascending: boolean }): this {
    this.orders.push({ column, ascending: options.ascending });
    return this;
  }

  limit(limit: number): this {
    this.rowLimit = limit;
    return this;
  }

  single(): Promise<QueryResult> {
    return this.execute().then((result) => {
      const rows = Array.isArray(result.data) ? result.data : [];
      return { ...result, data: rows[0] ?? null };
    });
  }

  maybeSingle(): Promise<QueryResult> {
    return this.single();
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
    const rows = this.database.rows(this.table)
      .filter((row) => this.matchesFilters(row))
      .sort((left, right) => this.compareRows(left, right));
    if (this.operation === "delete") {
      return this.executeDelete(rows);
    }
    return {
      data: structuredClone(this.rowLimit === undefined ? rows : rows.slice(0, this.rowLimit)),
      error: null
    };
  }

  private executeInsert(): QueryResult {
    assert.equal(this.table, "agent_sessions");
    const input = this.payload ?? {};
    if (typeof input.user_id !== "string") {
      this.database.unscopedQueryCount += 1;
      throw new Error("Insert omitted its verified user scope");
    }
    const id = String(input.id);
    if (this.database.sessions.has(id)) {
      return { data: null, error: { code: "23505", message: "duplicate key" } };
    }
    const timestamp = this.database.nextTimestamp();
    const row: ProductSessionRow = {
      id,
      user_id: input.user_id,
      presentation_id: String(input.presentation_id),
      title: String(input.title),
      message_count: Number(input.message_count),
      created_at: timestamp,
      updated_at: timestamp
    };
    this.database.sessions.set(id, row);
    return { data: [structuredClone(row)], error: null };
  }

  private executeDelete(rows: DatabaseRow[]): QueryResult {
    assert.equal(this.table, "agent_sessions");
    this.database.deleteAttempts += 1;
    if (this.database.deleteFailuresRemaining > 0) {
      this.database.deleteFailuresRemaining -= 1;
      return {
        data: null,
        error: { code: "57014", message: "transient delete failure" }
      };
    }
    rows.forEach((row) => {
      this.database.sessions.delete(row.id);
      for (let index = this.database.messages.length - 1; index >= 0; index -= 1) {
        if (this.database.messages[index]?.session_id === row.id) {
          this.database.messages.splice(index, 1);
        }
      }
    });
    return { data: structuredClone(rows), error: null };
  }

  private assertUserScope(): void {
    if (!this.filters.some(({ column, kind }) => column === "user_id" && kind === "eq")) {
      this.database.unscopedQueryCount += 1;
      throw new Error(`Query on ${this.table} omitted its verified user scope`);
    }
  }

  private matchesFilters(row: DatabaseRow): boolean {
    return this.filters.every(({ column, kind, value }) => {
      const rowValue = (row as unknown as Record<string, unknown>)[column];
      if (kind === "in") {
        return (value as unknown[]).includes(rowValue);
      }
      if (kind === "lt") {
        return typeof rowValue === "string"
          && typeof value === "string"
          && rowValue < value;
      }
      return rowValue === value;
    });
  }

  private compareRows(left: DatabaseRow, right: DatabaseRow): number {
    for (const { column, ascending } of this.orders) {
      const leftValue = String((left as unknown as Record<string, unknown>)[column]);
      const rightValue = String((right as unknown as Record<string, unknown>)[column]);
      const comparison = leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
      if (comparison !== 0) {
        return ascending ? comparison : -comparison;
      }
    }
    return 0;
  }
}
