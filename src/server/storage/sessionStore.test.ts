import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SessionCatalogCursorError,
  SessionStore
} from "./sessionStore.js";
import type { Session } from "../../shared/schema.js";

test("catalog pagination is stable for equal timestamps and excludes unbound sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slidex-session-catalog-"));
  const store = new SessionStore(root);

  try {
    await Promise.all([
      writeSession(root, createSession("session-b", true)),
      writeSession(root, createSession("session-c", true)),
      writeSession(root, createSession("session-z", false))
    ]);

    const first = await store.listAgentSessions("user-1", { limit: 1 });
    assert.deepEqual(first.items.map(({ id }) => id), ["session-c"]);
    assert.ok(first.nextCursor);

    const second = await store.listAgentSessions("user-1", {
      limit: 1,
      cursor: first.nextCursor
    });
    assert.deepEqual(second.items.map(({ id }) => id), ["session-b"]);
    assert.equal(second.nextCursor, undefined);

    await assert.rejects(
      store.listAgentSessions("user-1", { limit: 20, cursor: "malformed" }),
      SessionCatalogCursorError
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
