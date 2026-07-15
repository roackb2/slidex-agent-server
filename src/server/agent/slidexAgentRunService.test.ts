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
import {
  AgentRunProtocol,
  type Session,
  type StartAgentRunInput
} from "../../shared/schema.js";
import {
  SlideXAgentRunService,
  SlideXAgentRunServiceError,
  type AgentRunLogger,
  type SlideXAgentRunServiceOptions
} from "./slidexAgentRunService.js";
import { SLIDEX_ASSISTANT_MESSAGE_MAX_CHARS } from "./slidexHeddleAgent.js";

test("streams a reconnectable run and persists the completed SlideX session", async () => {
  const fixture = await createFixture();
  try {
    const accepted = await fixture.start({
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
    const accepted = await fixture.start({
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
      presentationId: "presentation-1",
      presentationTitle: "Test deck",
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
    const accepted = await fixture.start({
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
    const accepted = await fixture.start({
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
    const accepted = await fixture.start({
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
    const accepted = await fixture.start({
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

test("turns a rejected BYOK credential into a stable actionable terminal", async () => {
  const fixture = await createFixture(createEngine(async () => ({
    ...createTurnResult(),
    outcome: "error",
    summary: "LLM error: sensitive provider authentication detail",
    failure: { source: "model", code: "authentication" }
  })));
  try {
    const accepted = await fixture.start({
      message: "Update it",
      motionDoc: "# Original deck",
      sourceRevision: "revision-1",
      llmApiKey: "rejected-api-key"
    });
    const events = await collect(fixture.service.subscribe({
      userId: fixture.user.id,
      runId: accepted.runId
    }));
    const terminal = events.at(-1);

    assert.ok(terminal && terminal.kind === "error");
    assert.deepEqual(terminal.error, {
      code: "model_credential_rejected",
      message: "OpenAI rejected this API key. Check the key and try again."
    });
    assert.doesNotMatch(JSON.stringify(terminal), /sensitive provider/);

    const state = await fixture.service.getSessionState(fixture.user.id, accepted.session.id);
    assert.equal(
      state.session.messages.at(-1)?.content,
      "OpenAI rejected this API key. Check the key and try again."
    );
    assert.equal(
      state.session.messages.at(-1)?.metadata?.errorCode,
      "model_credential_rejected"
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("turns exhausted BYOK quota into a distinct actionable terminal", async () => {
  const fixture = await createFixture(createEngine(async () => ({
    ...createTurnResult(),
    outcome: "error",
    summary: "LLM error: sensitive provider quota and billing detail",
    failure: { source: "model", code: "quota" }
  })));
  try {
    const accepted = await fixture.start({
      message: "Update it",
      motionDoc: "# Original deck",
      sourceRevision: "revision-1",
      llmApiKey: "quota-exhausted-api-key"
    });
    const events = await collect(fixture.service.subscribe({
      userId: fixture.user.id,
      runId: accepted.runId
    }));
    const terminal = events.at(-1);

    assert.ok(terminal && terminal.kind === "error");
    assert.deepEqual(terminal.error, {
      code: "model_quota_exhausted",
      message: "This OpenAI API key is valid, but it has no available quota. Check the account billing or use a different key, then try again."
    });
    assert.doesNotMatch(JSON.stringify(terminal), /sensitive provider/);

    const state = await fixture.service.getSessionState(fixture.user.id, accepted.session.id);
    assert.equal(state.session.messages.at(-1)?.content, terminal.error.message);
    assert.equal(
      state.session.messages.at(-1)?.metadata?.errorCode,
      "model_quota_exhausted"
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("replaces source-like terminal summaries before returning or persisting them", async (t) => {
  const sourceLikeSummaries = [
    "```mdx\n# Deck source\n```",
    "<Slide duration={5}>secret source</Slide>",
    "<Table rows={secretRows} />",
    "Final MotionDoc source: # secret deck"
  ];

  for (const summary of sourceLikeSummaries) {
    await t.test(summary.split("\n")[0], async () => {
      const fixture = await createFixture(createEngine(async () => createTurnResult({ summary })));
      try {
        const accepted = await fixture.start({
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

        assert.ok(terminal && terminal.kind === "result");
        assert.equal(terminal.result.assistantMessage, "Updated the deck. Validation passed.");
        assert.ok(
          terminal.result.assistantMessage.length <= SLIDEX_ASSISTANT_MESSAGE_MAX_CHARS
        );
        assert.doesNotMatch(
          terminal.result.assistantMessage,
          /```|~~~|<Slide\b|Final MotionDoc source/i
        );

        const state = await fixture.service.getSessionState(
          fixture.user.id,
          accepted.session.id
        );
        assert.equal(
          state.session.messages.at(-1)?.content,
          terminal.result.assistantMessage
        );
      } finally {
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("bounds source-free assistant copy and retains the authoritative validation outcome", async () => {
  const fixture = await createFixture(createEngine(async () => createTurnResult({
    summary: "Updated the deck with clearer hierarchy and more focused copy. ".repeat(12)
  })));
  try {
    const accepted = await fixture.start({
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

    assert.ok(terminal && terminal.kind === "result");
    assert.ok(terminal.result.assistantMessage.length <= SLIDEX_ASSISTANT_MESSAGE_MAX_CHARS);
    assert.match(terminal.result.assistantMessage, /… Validation passed\.$/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("does not apply changed decks whose final source is invalid or unvalidated", async (t) => {
  for (const validation of [false, null, "tool_error"] as const) {
    await t.test(validation === false
      ? "invalid"
      : validation === null ? "unvalidated" : "validation tool error", async () => {
      const fixture = await createFixture(createEngine(async () => createTurnResult({
        validation
      })));
      try {
        const accepted = await fixture.start({
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
        assert.deepEqual(terminal.error, {
          code: "deck_validation_failed",
          message: "The agent produced a deck that did not pass validation, so it was not applied. Try again."
        });

        const state = await fixture.service.getSessionState(
          fixture.user.id,
          accepted.session.id
        );
        assert.equal(state.session.latestMotionDoc, "# Original deck");
        assert.equal(state.session.messages.at(-1)?.content, terminal.error.message);
        assert.equal(
          state.session.messages.at(-1)?.metadata?.errorCode,
          "deck_validation_failed"
        );
      } finally {
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("never exposes or persists the ephemeral model key", async () => {
  const sentinel = "sk-sentinel-ephemeral-only-123456";
  const records: Array<Record<string, unknown>> = [];
  const logger: AgentRunLogger = {
    info: (fields) => records.push(fields),
    warn: (fields) => records.push(fields)
  };
  const engine = createEngine();
  let receivedKey: string | undefined;
  const createEngineWithSentinel: NonNullable<SlideXAgentRunServiceOptions["createEngine"]> =
    async (_env, input) => {
      receivedKey = input.llmApiKey;
      return engine;
    };
  const fixture = await createFixture(engine, logger, createEngineWithSentinel);

  try {
    const accepted = await fixture.start({
      message: "Keep the credential out of durable state",
      motionDoc: "# Original deck",
      sourceRevision: "revision-1",
      llmApiKey: sentinel
    });
    const events = await collect(fixture.service.subscribe({
      userId: fixture.user.id,
      runId: accepted.runId
    }));
    const state = await fixture.service.getSessionState(fixture.user.id, accepted.session.id);
    const persistedFiles = await readUtf8Files(fixture.root);

    assert.equal(receivedKey, sentinel);
    assert.doesNotMatch(
      JSON.stringify({ accepted, events, state, records, persistedFiles }),
      new RegExp(sentinel)
    );
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
    const accepted = await fixture.start({
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
    const accepted = await fixture.start({
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

test("allows only one presentation to claim a legacy conversation concurrently", async () => {
  const sessionStore = new ConcurrentAttachSessionStore({
    id: "legacy-session",
    userId: "test-user",
    title: "Legacy conversation",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    latestMotionDoc: "# Legacy deck",
    messages: []
  });
  const service = new SlideXAgentRunService({
    env: {
      NODE_ENV: "test",
      PORT: 3000,
      DEFAULT_MODEL: "gpt-test",
      AGENT_DRIVER: "mock",
      dataDir: "unused"
    } as Env,
    sessionStore
  });

  const outcomes = await Promise.allSettled([
    service.attachSessionToPresentation("test-user", "legacy-session", {
      presentationId: "presentation-1",
      presentationTitle: "Deck one"
    }),
    service.attachSessionToPresentation("test-user", "legacy-session", {
      presentationId: "presentation-2",
      presentationTitle: "Deck two"
    })
  ]);
  const fulfilled = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<Session> => outcome.status === "fulfilled"
  );
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
  );

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0]?.reason instanceof SlideXAgentRunServiceError
      && rejected[0].reason.code === "invalid_request"
  );
  assert.equal(
    sessionStore.current().presentationId,
    fulfilled[0]?.value.presentationId
  );
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

test("withholds untrusted assistant stream text until terminal projection", () => {
  const event = AgentRunProtocol.parseEvent({
    kind: "activity",
    runId: "run-1",
    sequence: 1,
    timestamp: "2026-07-11T00:00:00.000Z",
    activity: {
      type: "assistant.stream",
      text: "Final MotionDoc source: <Slide>secret</Slide>"
    }
  });

  assert.ok(event.kind === "activity");
  assert.deepEqual(event.activity, { type: "assistant.stream" });
});

async function createFixture(
  engine = createEngine(),
  logger?: AgentRunLogger,
  createEngineFactory?: NonNullable<SlideXAgentRunServiceOptions["createEngine"]>
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
    createEngine: createEngineFactory ?? (async () => engine),
    logger
  });
  const start = (
    input: AgentRunTestInput,
    options?: Parameters<SlideXAgentRunService["start"]>[2]
  ) => service.start(user, {
    presentationId: "presentation-1",
    presentationTitle: "Test deck",
    ...input
  }, options);
  return { root, service, sessionStore, start, user };
}

type AgentRunTestInput = Omit<
  StartAgentRunInput,
  "presentationId" | "presentationTitle"
> & Partial<Pick<StartAgentRunInput, "presentationId" | "presentationTitle">>;

async function readUtf8Files(root: string): Promise<Array<{ path: string; content: string }>> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return readUtf8Files(entryPath);
    }
    return [{ path: entryPath, content: await fs.readFile(entryPath, "utf8") }];
  }));
  return files.flat();
}

function createEngine(
  submit: (input: SubmitConversationTurnInput) => Promise<ConversationTurnResultSummary> = async () => createTurnResult()
): ConversationEngine {
  const sessions = new Map<string, { id: string; model?: string }>();
  let currentArtifactId: string | undefined;

  return {
    sessions: {
      readExisting: async (id: string) => sessions.get(id),
      create: async (input: CreateConversationSessionInput = {}) => {
        const session = { id: input.id ?? "test-session", model: input.model };
        sessions.set(session.id, session);
        return session;
      },
      updateSettings: async (
        id: string,
        input: UpdateConversationSessionSettingsInput
      ) => {
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

function createTurnResult(input: {
  summary?: string;
  validation?: boolean | null | "tool_error";
} = {}): ConversationTurnResultSummary {
  const validation = input.validation === null
    ? []
    : [createValidationToolResult(
        typeof input.validation === "boolean" ? input.validation : true,
        input.validation === "tool_error"
      )];
  return {
    outcome: "complete",
    summary: input.summary ?? "Updated the deck",
    session: {} as ConversationTurnResultSummary["session"],
    artifacts: [],
    toolResults: validation
  };
}

function createValidationToolResult(
  isValid: boolean,
  isError = false
): ConversationTurnResultSummary["toolResults"][number] {
  return {
    call: {
      id: "validate-final-motiondoc",
      tool: "slidex_validate_motion_doc",
      input: { source: "# Updated deck" }
    },
    result: {
      ok: true,
      output: {
        isError,
        structuredContent: {
          result: { isValid, issues: [] }
        }
      }
    },
    durationMs: 1,
    step: 1,
    timestamp: "2026-07-11T00:00:00.000Z"
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

class ConcurrentAttachSessionStore extends SessionStore {
  private session: Session;

  constructor(session: Session) {
    super("unused");
    this.session = session;
  }

  override async getSession(userId: string, sessionId: string): Promise<Session | null> {
    return this.session.userId === userId && this.session.id === sessionId
      ? structuredClone(this.session)
      : null;
  }

  override async writeSession(session: Session): Promise<Session> {
    await Promise.resolve();
    this.session = structuredClone(session);
    return structuredClone(this.session);
  }

  current(): Session {
    return structuredClone(this.session);
  }
}
