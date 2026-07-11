import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createApp } from "../app.js";
import { AuthService } from "../auth.js";
import { loadEnv, type Env } from "../env.js";
import { StdioMcpProcessManager } from "../mcp/stdioMcp.js";
import { SessionStore } from "../storage/sessionStore.js";
import type { SlideXAgentRunService } from "../agent/slidexAgentRunService.js";
import type { AgentRunEvent } from "../../shared/schema.js";
import {
  createSubscribeAgentRunHandler,
  type AgentRunRouteDeps
} from "./agentRuns.js";

test("defaults the reconnectable run API flag to disabled", () => {
  const previous = process.env.SLIDEX_AGENT_ENABLED;
  delete process.env.SLIDEX_AGENT_ENABLED;

  try {
    assert.equal(loadEnv().SLIDEX_AGENT_ENABLED, false);
  } finally {
    if (previous === undefined) {
      delete process.env.SLIDEX_AGENT_ENABLED;
    } else {
      process.env.SLIDEX_AGENT_ENABLED = previous;
    }
  }
});

test("keeps the reconnectable run API hidden while preserving the legacy stream when disabled", async () => {
  await withAgentFeature(false, async (baseUrl) => {
    const runResponse = await postJson(`${baseUrl}/api/agent/runs`);
    const legacyResponse = await postJson(`${baseUrl}/api/agent/stream`);

    assert.equal(runResponse.status, 404);
    assert.equal(legacyResponse.status, 401);
  });
});

test("registers the reconnectable run API when explicitly enabled", async () => {
  await withAgentFeature(true, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/agent/runs`);

    assert.equal(response.status, 401);
  });
});

test("streams canonical SSE frames and resumes from Last-Event-ID", async () => {
  let afterSequence: number | undefined;
  const events: AgentRunEvent[] = [
    {
      kind: "activity",
      runId: "run-1",
      sequence: 4,
      timestamp: "2026-07-11T00:00:00.000Z",
      activity: { type: "assistant.stream", text: "Working" }
    },
    {
      kind: "cancelled",
      runId: "run-1",
      sequence: 5,
      timestamp: "2026-07-11T00:00:01.000Z",
      reason: "Cancelled by user"
    }
  ];
  const deps = {
    authService: {
      requireUserFromRequest: async () => ({ id: "user-1" })
    } as unknown as AuthService,
    agentRunService: {
      subscribe: (input: { afterSequence?: number }) => {
        afterSequence = input.afterSequence;
        return toAsyncIterable(events);
      }
    } as unknown as SlideXAgentRunService
  } satisfies AgentRunRouteDeps;
  const app = express();
  app.get("/api/agent/runs/:runId/events", createSubscribeAgentRunHandler(deps));
  const server = app.listen(0);
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/agent/runs/run-1/events`,
      { headers: { "Last-Event-ID": "3" } }
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(afterSequence, 3);
    assert.deepEqual(parseSseFrames(await response.text()), [
      { event: "activity", id: "4", kind: "activity", sequence: 4 },
      { event: "cancelled", id: "5", kind: "cancelled", sequence: 5 }
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

function toAsyncIterable(events: AgentRunEvent[]): AsyncIterable<AgentRunEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    }
  };
}

function parseSseFrames(text: string) {
  return text
    .trim()
    .split("\n\n")
    .map((frame) => Object.fromEntries(
      frame.split("\n").map((line) => {
        const separator = line.indexOf(": ");
        return [line.slice(0, separator), line.slice(separator + 2)];
      })
    ))
    .map(({ event, id, data }) => {
      const payload = JSON.parse(data) as AgentRunEvent;
      return { event, id, kind: payload.kind, sequence: payload.sequence };
    });
}

async function withAgentFeature(
  enabled: boolean,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slidex-agent-flag-"));
  const env: Env = {
    NODE_ENV: "test",
    PORT: 3000,
    AGENT_DRIVER: "mock",
    SLIDEX_AGENT_ENABLED: enabled,
    DEFAULT_MODEL: "gpt-test",
    dataDir: root
  };
  const mcpManager = new StdioMcpProcessManager(env);
  const app = createApp({
    env,
    authService: new AuthService(env),
    sessionStore: new SessionStore(root),
    mcpManager
  });
  const server = app.listen(0);
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await mcpManager.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function postJson(url: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
}
