import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionCatalogCursorError } from "./agentSessionRepository.js";
import { SessionStore } from "./sessionStore.js";
import type { Session } from "../../shared/schema.js";

test("catalog pagination is stable for equal timestamps and excludes unbound sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slidex-session-catalog-"));
  const store = new SessionStore(root);

  try {
    await Promise.all([
      writeSession(root, createSession("session-Z-1", true)),
      writeSession(root, createSession("session-a-2", true)),
      writeSession(root, createSession("session-unbound", false))
    ]);

    const first = await store.listAgentSessions("user-1", { limit: 1 });
    assert.deepEqual(first.items.map(({ id }) => id), ["session-a-2"]);
    assert.ok(first.nextCursor);

    const second = await store.listAgentSessions("user-1", {
      limit: 1,
      cursor: first.nextCursor
    });
    assert.deepEqual(second.items.map(({ id }) => id), ["session-Z-1"]);
    assert.equal(second.nextCursor, undefined);

    await assert.rejects(
      store.listAgentSessions("user-1", { limit: 20, cursor: "malformed" }),
      SessionCatalogCursorError
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("run messages are idempotent by session, run, and lifecycle kind", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slidex-session-message-"));
  const store = new SessionStore(root);

  try {
    const session = await store.createSession({
      userId: "user-1",
      title: "Conversation",
      motionDoc: "# Original",
      presentationId: "presentation-1",
      presentationTitle: "Presentation"
    });
    const input = {
      userId: "user-1",
      sessionId: session.id,
      runId: "run-1",
      kind: "user_input" as const,
      role: "user" as const,
      content: "Make the title clearer",
      latestMotionDoc: "# Current"
    };

    const first = await store.appendRunMessage(input);
    const retry = await store.appendRunMessage(input);

    assert.equal(first?.messages.length, 1);
    assert.equal(retry?.messages.length, 1);
    assert.equal(retry?.latestMotionDoc, "# Current");
    await assert.rejects(
      store.appendRunMessage({ ...input, content: "Different content" }),
      /already has a different user_input message/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("presentation binding is immutable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slidex-session-binding-"));
  const store = new SessionStore(root);

  try {
    const session = await store.createSession({ userId: "user-1" });
    const attached = await store.attachSessionToPresentation("user-1", session.id, {
      presentationId: "presentation-1",
      presentationTitle: "First deck"
    });

    assert.equal(attached?.presentationId, "presentation-1");
    await assert.rejects(
      store.attachSessionToPresentation("user-1", session.id, {
        presentationId: "presentation-2",
        presentationTitle: "Second deck"
      }),
      /different presentation/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function createSession(id: string, bound: boolean): Session {
  return {
    id,
    userId: "user-1",
    title: `Conversation ${id}`,
    ...(bound
      ? {
          presentationId: `presentation-${id}`,
          presentationTitle: `Presentation ${id}`
        }
      : {}),
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    latestMotionDoc: "# Deck",
    messages: []
  };
}

async function writeSession(root: string, session: Session): Promise<void> {
  const dir = path.join(root, "sessions", session.userId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${session.id}.json`),
    JSON.stringify(session),
    "utf8"
  );
}
