import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ConversationActivity,
  ConversationEngine,
  ConversationTurnResultSummary,
  CreateConversationSessionInput,
  SubmitConversationTurnInput,
  UpdateConversationSessionSettingsInput
} from "@roackb2/heddle";
import type { AuthUser } from "../auth.js";
import type { Env } from "../env.js";
import { SessionStore } from "../storage/sessionStore.js";
import { AgentRunProtocol } from "../../shared/schema.js";
import {
  SlideXAgentRunService,
  SlideXAgentRunServiceError,
  type AgentRunLogger
} from "./slidexAgentRunService.js";

test("streams a reconnectable run and persists the completed SlideX session", async () => {
  const fixture = await createFixture();
  try {
    const accepted = await fixture.service.start(fixture.user, {
      message: "Make the title more direct",
      motionDoc: "# Original deck",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key",
      model: "gpt-test"
    });

    const events = await collect(fixture.service.subscribe({
      userId: fixture.user.id,
      runId: accepted.runId
    }));
    events.forEach((event) => AgentRunProtocol.parseEvent(event));
    const complete = events.find((event) => event.kind === "result");

    assert.ok(complete && complete.kind === "result");
    assert.match(complete.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(complete.result.motionDoc, "# Updated deck");
    assert.equal(complete.result.baseSourceRevision, "revision-1");
    assert.deepEqual(
      complete.result.session.messages.map(({ role }) => role),
      ["user", "assistant"]
    );
    assert.deepEqual(
      AgentRunProtocol.parseEvent(JSON.parse(AgentRunProtocol.stringifyEvent(complete))),
      complete
    );

    const replay = await collect(fixture.service.subscribe({
      userId: fixture.user.id,
      runId: accepted.runId,
      afterSequence: complete.sequence - 1
    }));
    assert.deepEqual(replay.map(({ kind }) => kind), ["result"]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("emits correlation-safe accepted and terminal lifecycle facts", async () => {
  const records: Array<{
    level: "info" | "warn";
    fields: Record<string, unknown>;
    message: string;
  }> = [];
  const logger: AgentRunLogger = {
    info: (fields, message) => records.push({ level: "info", fields, message }),
    warn: (fields, message) => records.push({ level: "warn", fields, message })
  };
  const fixture = await createFixture(createEngine(), logger);

  try {
    const accepted = await fixture.service.start(fixture.user, {
      message: "Sensitive user request",
      motionDoc: "# Sensitive source",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key",
      model: "gpt-test"
    }, { correlationId: "request-1" });
    await collect(fixture.service.subscribe({
      userId: fixture.user.id,
      runId: accepted.runId
    }));

    const acceptedLog = records.find(({ fields }) => fields.event === "agent_run.accepted");
    const terminalLog = records.find(({ fields }) => fields.event === "agent_run.terminal");
    assert.ok(acceptedLog);
    assert.deepEqual(acceptedLog.fields, {
      event: "agent_run.accepted",
      runId: accepted.runId,
      sessionId: accepted.session.id,
      model: "gpt-test",
      correlationId: "request-1"
    });
    assert.ok(terminalLog);
    assert.ok(records.indexOf(acceptedLog) < records.indexOf(terminalLog));
    assert.equal(terminalLog.fields.runId, accepted.runId);
    assert.equal(terminalLog.fields.sessionId, accepted.session.id);
    assert.equal(terminalLog.fields.outcome, "complete");
    assert.equal(terminalLog.fields.correlationId, "request-1");
    assert.equal(typeof terminalLog.fields.durationMs, "number");
    assert.doesNotMatch(
      JSON.stringify(records),
      /Sensitive user request|Sensitive source|test-api-key|test-user/
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("runs the deterministic mock through the same reconnectable lifecycle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slidex-agent-mock-run-"));
  const sessionStore = new SessionStore(root);
  const user: AuthUser = { id: "mock-user" };
  const service = new SlideXAgentRunService({
    env: {
      NODE_ENV: "test",
      PORT: 3000,
      DEFAULT_MODEL: "gpt-test",
      AGENT_DRIVER: "mock",
      dataDir: root
    } as Env,
    sessionStore
  });

  try {
    const accepted = await service.start(user, {
      message: "Add a recovery note",
      motionDoc: "# Original deck",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key"
    });
    const events = await collect(service.subscribe({
      userId: user.id,
      runId: accepted.runId
    }));
    const result = events.at(-1);

    assert.ok(result && result.kind === "result");
    assert.match(result.result.motionDoc, /Agent note/);
    assert.deepEqual(
      events
        .filter((event) => event.kind === "activity")
        .map((event) => event.activity.type)
        .filter((type, index, values) => values.indexOf(type) === index),
      ["tool.calling", "tool.completed", "assistant.stream"]
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("keeps runs private to the authenticated user", async () => {
  const fixture = await createFixture();
  try {
    const accepted = await fixture.service.start(fixture.user, {
      message: "Update it",
      motionDoc: "# Original deck",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key"
    });

    assert.throws(
      () => fixture.service.cancel("another-user", accepted.runId),
      /Agent run not found/
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("hydrates durable history and delegates active-run discovery to Heddle", async () => {
  const turn = deferred<void>();
  const fixture = await createFixture(createEngine(async () => {
    await turn.promise;
    return createTurnResult();
  }));
  try {
    const accepted = await fixture.service.start(fixture.user, {
      message: "Keep working",
      motionDoc: "# Original deck",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key"
    });

    const running = await fixture.service.getSessionState(fixture.user.id, accepted.session.id);
    assert.equal(running.activeRun?.runId, accepted.runId);
    assert.deepEqual(running.session.messages.map(({ role }) => role), ["user"]);

    turn.resolve();
    await collect(fixture.service.subscribe({
      userId: fixture.user.id,
      runId: accepted.runId
    }));

    const settled = await fixture.service.getSessionState(fixture.user.id, accepted.session.id);
    assert.equal(settled.activeRun, null);
    assert.deepEqual(settled.session.messages.map(({ role }) => role), ["user", "assistant"]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("persists an explainable cancelled terminal message", async () => {
  const fixture = await createFixture(createEngine((input) => new Promise((_, reject) => {
    const abort = () => reject(new Error("provider cancellation detail"));
    if (input.abortSignal?.aborted) {
      abort();
      return;
    }
    input.abortSignal?.addEventListener("abort", abort, { once: true });
  })));
  try {
    const accepted = await fixture.service.start(fixture.user, {
      message: "Make a long update",
      motionDoc: "# Original deck",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key"
    });

    assert.equal(fixture.service.cancel(fixture.user.id, accepted.runId), true);
    const events = await collect(fixture.service.subscribe({
      userId: fixture.user.id,
      runId: accepted.runId
    }));
    assert.equal(events.at(-1)?.kind, "cancelled");

    const state = await fixture.service.getSessionState(fixture.user.id, accepted.session.id);
    assert.equal(state.session.messages.at(-1)?.content, "Run cancelled.");
    assert.equal(state.session.messages.at(-1)?.metadata?.outcome, "cancelled");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("sanitizes run failures and persists their terminal meaning", async () => {
  const fixture = await createFixture(createEngine(async () => {
    throw new Error("sensitive provider failure detail");
  }));
  try {
    const accepted = await fixture.service.start(fixture.user, {
      message: "Update it",
      motionDoc: "# Original deck",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key"
    });
    const events = await collect(fixture.service.subscribe({
      userId: fixture.user.id,
      runId: accepted.runId
    }));
    const terminal = events.at(-1);

    assert.ok(terminal && terminal.kind === "error");
    assert.equal(terminal.error.message, "The agent could not complete this request. Try again.");
    assert.doesNotMatch(terminal.error.message, /sensitive provider/);

    const state = await fixture.service.getSessionState(fixture.user.id, accepted.session.id);
    assert.equal(
      state.session.messages.at(-1)?.content,
      "The agent could not complete this request. Try again."
    );
    assert.equal(state.session.messages.at(-1)?.metadata?.outcome, "error");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("keeps result persistence failures distinct without exposing storage details", async () => {
  const turn = deferred<void>();
  const fixture = await createFixture(createEngine(async () => {
    await turn.promise;
    return createTurnResult();
  }));
  try {
    const accepted = await fixture.service.start(fixture.user, {
      message: "Update it",
      motionDoc: "# Original deck",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key"
    });
    fixture.sessionStore.writeSession = async () => {
      throw new Error("sensitive storage failure detail");
    };
    turn.resolve();

    const events = await collect(fixture.service.subscribe({
      userId: fixture.user.id,
      runId: accepted.runId
    }));
    const terminal = events.at(-1);

    assert.ok(terminal && terminal.kind === "error");
    assert.deepEqual(terminal.error, {
      code: "finalization_failed",
      message: "The agent finished, but its deck result could not be saved"
    });
    assert.doesNotMatch(JSON.stringify(terminal), /sensitive storage/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("resets product state without allowing an in-flight run to recreate it", async () => {
  const turn = deferred<void>();
  const fixture = await createFixture(createEngine(async () => {
    await turn.promise;
    return createTurnResult();
  }));
  try {
    const accepted = await fixture.service.start(fixture.user, {
      message: "Keep working",
      motionDoc: "# Original deck",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key"
    });

    assert.deepEqual(
      await fixture.service.resetSession(fixture.user.id, accepted.session.id),
      { reset: true }
    );
    assert.equal(
      await fixture.sessionStore.getSession(fixture.user.id, accepted.session.id),
      null
    );

    turn.resolve();
    await collect(fixture.service.subscribe({
      userId: fixture.user.id,
      runId: accepted.runId
    }));
    assert.equal(
      await fixture.sessionStore.getSession(fixture.user.id, accepted.session.id),
      null
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("reports missing sessions with a stable product error", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      fixture.service.getSessionState(fixture.user.id, "missing"),
      (error: unknown) => error instanceof SlideXAgentRunServiceError
        && error.code === "session_not_found"
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("projects Heddle activities to the JSON-safe public client shape", () => {
  const event = AgentRunProtocol.parseEvent({
    kind: "activity",
    runId: "run-1",
    sequence: 1,
    timestamp: "2026-07-11T00:00:00.000Z",
    activity: {
      type: "loop.finished",
      state: {
        trace: [{ diagnostics: undefined }]
      }
    }
  });

  assert.ok(event.kind === "activity");
  assert.deepEqual(event.activity, { type: "loop.finished" });
});

async function createFixture(
  engine = createEngine(),
  logger?: AgentRunLogger
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slidex-agent-run-"));
  const sessionStore = new SessionStore(root);
  const user: AuthUser = { id: "test-user" };
  const service = new SlideXAgentRunService({
    env: {
      NODE_ENV: "test",
      PORT: 3000,
      DEFAULT_MODEL: "gpt-test",
      AGENT_DRIVER: "heddle",
      dataDir: root
    } as Env,
    sessionStore,
    createEngine: async () => engine,
    logger
  });
  return { root, service, sessionStore, user };
}

function createEngine(
  submit: (input: SubmitConversationTurnInput) => Promise<ConversationTurnResultSummary> = async () => createTurnResult()
): ConversationEngine {
  const sessions = new Map<string, { id: string; model?: string }>();
  let currentArtifactId: string | undefined;

  return {
    sessions: {
      readExisting: (id: string) => sessions.get(id),
      create: (input: CreateConversationSessionInput = {}) => {
        const session = { id: input.id ?? "test-session", model: input.model };
        sessions.set(session.id, session);
        return session;
      },
      updateSettings: (id: string, input: UpdateConversationSessionSettingsInput) => {
        const session = { ...sessions.get(id), id, model: input.model };
        sessions.set(id, session);
        return session;
      }
    },
    turns: {
      submit: async (input: SubmitConversationTurnInput) => {
        const result = await submit(input);
        currentArtifactId = "updated-motiondoc";
        input.host?.events?.onActivity?.({
          type: "assistant.stream",
          step: 1,
          text: "Updated the deck",
          timestamp: new Date().toISOString()
        } as ConversationActivity);
        return result;
      }
    },
    artifacts: {
      current: () => currentArtifactId ? { id: currentArtifactId } : undefined,
      read: () => ({ content: "# Updated deck" })
    }
  } as unknown as ConversationEngine;
}

function createTurnResult(): ConversationTurnResultSummary {
  return {
    outcome: "complete",
    summary: "Updated the deck",
    session: {} as ConversationTurnResultSummary["session"],
    artifacts: [],
    toolResults: []
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) {
    values.push(event);
  }
  return values;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
