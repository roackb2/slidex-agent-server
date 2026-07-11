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
import { SlideXAgentRunService } from "./slidexAgentRunService.js";

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

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slidex-agent-run-"));
  const sessionStore = new SessionStore(root);
  const engine = createEngine();
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
    createEngine: async () => engine
  });
  return { root, service, user };
}

function createEngine(): ConversationEngine {
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
        currentArtifactId = "updated-motiondoc";
        input.host?.events?.onActivity?.({
          type: "assistant.stream",
          step: 1,
          text: "Updated the deck",
          timestamp: new Date().toISOString()
        } as ConversationActivity);
        return createTurnResult();
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
