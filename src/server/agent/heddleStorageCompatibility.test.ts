import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConversationEngine } from "@roackb2/heddle";
import { resolveConversationSession } from "./slidexHeddleAgent.js";

type StoredCatalog = {
  version: 1;
  sessions: Array<Record<string, unknown> & { id: string; revision?: number }>;
};

test("upgrades a Heddle v4 session without losing SlideX conversation history", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "slidex-heddle-v5-storage-")
  );
  const slideXSessionId = "product-session-1";
  const heddleSessionId = `slidex-${slideXSessionId}`;

  try {
    const legacyWriter = createTestEngine(stateRoot, "gpt-4.1");
    await legacyWriter.sessions.create({
      id: heddleSessionId,
      name: `SlideX session ${slideXSessionId}`,
      model: "gpt-4.1"
    });
    await legacyWriter.sessions.appendMessage(heddleSessionId, {
      id: "message-1",
      role: "user",
      text: "Preserve this durable conversation"
    });

    await convertCurrentStorageToV4Layout(stateRoot, heddleSessionId);

    const upgradedEngine = createTestEngine(stateRoot, "gpt-5.4");
    const resolved = await resolveConversationSession(
      upgradedEngine,
      slideXSessionId,
      "gpt-5.4"
    );
    const preserved = await upgradedEngine.sessions.readExisting(
      heddleSessionId
    );

    assert.equal(resolved.id, heddleSessionId);
    assert.equal(preserved?.model, "gpt-5.4");
    assert.deepEqual(preserved?.messages, [{
      id: "message-1",
      role: "user",
      text: "Preserve this durable conversation"
    }]);

    const migratedCatalog = await readCatalog(stateRoot);
    assert.equal(migratedCatalog.sessions[0]?.revision, 2);
    await fs.access(
      path.join(
        stateRoot,
        "chat-sessions",
        `${encodeURIComponent(heddleSessionId)}.2.json`
      )
    );
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

function createTestEngine(stateRoot: string, model: string) {
  return createConversationEngine({
    workspaceRoot: stateRoot,
    stateRoot,
    model,
    memoryMaintenanceMode: "none",
    toolProfile: {
      preset: "default",
      memoryMode: "none"
    }
  });
}

async function convertCurrentStorageToV4Layout(
  stateRoot: string,
  sessionId: string
): Promise<void> {
  const catalog = await readCatalog(stateRoot);
  const entry = catalog.sessions.find((candidate) => candidate.id === sessionId);
  assert.ok(entry?.revision);

  const sessionsDir = path.join(stateRoot, "chat-sessions");
  const revisionBody = await fs.readFile(
    path.join(
      sessionsDir,
      `${encodeURIComponent(sessionId)}.${entry.revision}.json`
    ),
    "utf8"
  );

  delete entry.revision;
  await fs.rm(sessionsDir, { recursive: true, force: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, `${sessionId}.json`),
    revisionBody
  );
  await fs.writeFile(
    path.join(stateRoot, "chat-sessions.catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`
  );
}

async function readCatalog(stateRoot: string): Promise<StoredCatalog> {
  return JSON.parse(
    await fs.readFile(
      path.join(stateRoot, "chat-sessions.catalog.json"),
      "utf8"
    )
  ) as StoredCatalog;
}
