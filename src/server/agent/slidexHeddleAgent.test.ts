import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationTurnResultSummary } from "@roackb2/heddle";
import type { AgentProgressEvent } from "./types.js";
import {
  runSlideXAgent,
  type ConversationEngineLike
} from "./slidexHeddleAgent.js";
import { MOTIONDOC_RESULT_ARTIFACT_RULES } from "./slidexExtension.js";

const HEDDLE_SESSION_ID = "heddle-session";

test("declares mirror capture for every MotionDoc-writing tool", () => {
  assert.deepEqual(
    MOTIONDOC_RESULT_ARTIFACT_RULES.map((rule) => rule.toolName),
    [
      "slidex_create_deck",
      "slidex_create_from_template",
      "slidex_replace_slide",
      "slidex_update_slide_props",
      "slidex_add_block",
      "slidex_delete_slide",
      "slidex_reorder_slide",
      "slidex_create_slide_from_layout",
      "slidex_add_slide_from_layout",
      "slidex_replace_slide_with_layout"
    ]
  );
  MOTIONDOC_RESULT_ARTIFACT_RULES.forEach((rule) => {
    assert.equal(rule.path, "structuredContent.result.source");
    assert.equal(rule.mode, "mirror");
    assert.equal(rule.kind, "source");
    assert.equal(rule.domain, "slidex.motiondoc");
    assert.equal(rule.extension, "mdx");
    assert.equal(rule.setCurrent, true);
  });
});

test("returns and emits the current mirrored MotionDoc artifact", async () => {
  const events: AgentProgressEvent[] = [];
  const result = await runSlideXAgent({
    engine: createEngine({ artifactContent: "# Updated deck" }),
    sessionId: "slidex-session",
    motionDoc: "# Original deck",
    message: "Update the deck",
    model: "gpt-5.4",
    signal: new AbortController().signal,
    emit: (event) => {
      events.push(event);
    }
  });

  assert.equal(result.motionDoc, "# Updated deck");
  assert.deepEqual(
    events.find((event) => event.type === "motionDoc"),
    { type: "motionDoc", motionDoc: "# Updated deck" }
  );
});

test("preserves the existing MotionDoc when the turn creates no artifact", async () => {
  const result = await runSlideXAgent({
    engine: createEngine(),
    sessionId: "slidex-session",
    motionDoc: "# Existing deck",
    message: "What is this deck about?",
    model: "gpt-5.4",
    signal: new AbortController().signal,
    emit: () => undefined
  });

  assert.equal(result.motionDoc, "# Existing deck");
});

test("fails when Heddle reports a current artifact that cannot be read", async () => {
  await assert.rejects(
    runSlideXAgent({
      engine: createEngine({ unreadableArtifact: true }),
      sessionId: "slidex-session",
      motionDoc: "# Existing deck",
      message: "Update the deck",
      model: "gpt-5.4",
      signal: new AbortController().signal,
      emit: () => undefined
    }),
    /Current MotionDoc artifact artifact-motiondoc could not be read/
  );
});

test("reuses one Heddle session and submits only the current request", async () => {
  const harness = createEngineHarness();

  await runSlideXAgent({
    engine: harness.engine,
    sessionId: "slidex-session",
    motionDoc: "# Deck",
    message: "Make slide 2 more visual",
    model: "gpt-5.4",
    signal: new AbortController().signal,
    emit: () => undefined
  });
  await runSlideXAgent({
    engine: harness.engine,
    sessionId: "slidex-session",
    motionDoc: "# Deck\n\n## Visual slide",
    message: "Add a conclusion in the same tone",
    model: "gpt-4.1",
    signal: new AbortController().signal,
    emit: () => undefined
  });

  assert.deepEqual(harness.createdSessionIds, ["slidex-slidex-session"]);
  assert.deepEqual(harness.updatedModels, ["gpt-4.1"]);
  assert.deepEqual(
    harness.submissions.map((submission) => submission.sessionId),
    ["slidex-slidex-session", "slidex-slidex-session"]
  );
  assert.equal(countOccurrences(harness.submissions[1]?.prompt ?? "", "Add a conclusion in the same tone"), 1);
  assert.doesNotMatch(harness.submissions[1]?.prompt ?? "", /Conversation so far:/);
});

test("does not replace newer product state with a previous turn artifact", async () => {
  const harness = createEngineHarness({
    currentArtifactId: "artifact-previous",
    artifactContent: "# Previous agent version"
  });

  const result = await runSlideXAgent({
    engine: harness.engine,
    sessionId: "slidex-session",
    motionDoc: "# Manually edited version",
    message: "What is the deck about?",
    model: "gpt-5.4",
    signal: new AbortController().signal,
    emit: () => undefined
  });

  assert.equal(result.motionDoc, "# Manually edited version");
});

function createEngine(options: {
  artifactContent?: string;
  unreadableArtifact?: boolean;
} = {}): ConversationEngineLike {
  const harness = createEngineHarness({
    artifactContent: options.artifactContent,
    nextArtifactId: options.artifactContent !== undefined || options.unreadableArtifact
      ? "artifact-motiondoc"
      : undefined,
    unreadableArtifact: options.unreadableArtifact
  });
  return harness.engine;
}

function createEngineHarness(options: {
  currentArtifactId?: string;
  nextArtifactId?: string;
  artifactContent?: string;
  unreadableArtifact?: boolean;
} = {}): {
  engine: ConversationEngineLike;
  createdSessionIds: string[];
  updatedModels: string[];
  submissions: Array<{ sessionId: string; prompt: string }>;
} {
  const sessions = new Map<string, { id: string; model?: string }>();
  const createdSessionIds: string[] = [];
  const updatedModels: string[] = [];
  const submissions: Array<{ sessionId: string; prompt: string }> = [];
  let currentArtifactId = options.currentArtifactId;

  return {
    createdSessionIds,
    updatedModels,
    submissions,
    engine: {
      sessions: {
        readExisting: (id) => sessions.get(id),
        create: (input) => {
          const id = input.id ?? HEDDLE_SESSION_ID;
          const session = { id, model: input.model };
          sessions.set(id, session);
          createdSessionIds.push(id);
          return session;
        },
        updateSettings: (id, input) => {
          const session = sessions.get(id);
          if (!session) {
            throw new Error(`Missing test session ${id}`);
          }
          const updated = { ...session, model: input.model ?? session.model };
          sessions.set(id, updated);
          if (input.model) {
            updatedModels.push(input.model);
          }
          return updated;
        }
      },
      turns: {
        submit: async (input) => {
          submissions.push({ sessionId: input.sessionId, prompt: input.prompt });
          currentArtifactId = options.nextArtifactId ?? currentArtifactId;
          return createTurnResult();
        }
      },
      artifacts: {
        current: () => currentArtifactId ? { id: currentArtifactId } : undefined,
        read: () => {
          if (options.unreadableArtifact || options.artifactContent === undefined) {
            return undefined;
          }
          return { content: options.artifactContent };
        }
      }
    }
  };
}

function countOccurrences(value: string, target: string): number {
  return value.split(target).length - 1;
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
