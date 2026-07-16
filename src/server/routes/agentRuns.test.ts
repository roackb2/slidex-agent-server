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
import { SlideXAgentRunServiceError } from "../agent/slidexAgentRunService.js";
import {
  AgentSessionPageSchema,
  AgentRunEventSchema,
  AgentSessionStateSchema,
  StartAgentRunResultSchema,
  type AgentRunEvent,
  type Session,
  type StartAgentRunInput
} from "../../shared/schema.js";
import {
  createAttachAgentSessionHandler,
  createCancelAgentRunHandler,
  createGetAgentSessionHandler,
  createResetAgentSessionHandler,
  createStartAgentRunHandler,
  createSubscribeAgentRunHandler,
  type AgentRunRouteDeps
} from "./agentRuns.js";

test("defaults the reconnectable run API flag to disabled", () => {
  assert.equal(loadEnv({}).SLIDEX_AGENT_ENABLED, false);
});

test("keeps the reconnectable run API hidden while preserving the legacy stream when disabled", async () => {
  await withMockAgentApp({ enabled: false }, async (baseUrl) => {
    const runResponse = await postJson(`${baseUrl}/api/agent/runs`);
    const sessionsResponse = await fetch(`${baseUrl}/api/agent/sessions`);
    const sessionResponse = await fetch(`${baseUrl}/api/agent/sessions/session-1`);
    const legacyResponse = await postJson(`${baseUrl}/api/agent/stream`);

    assert.equal(runResponse.status, 404);
    assert.equal(sessionsResponse.status, 404);
    assert.equal(sessionResponse.status, 404);
    assert.equal(legacyResponse.status, 401);
  });
});

test("enforces an exact credential-free browser CORS allowlist", async () => {
  await withMockAgentApp({
    enabled: true,
    corsOrigin: "https://Editor.Example/, https://preview.example"
  }, async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/healthz`, {
      headers: { origin: "https://editor.example" }
    });
    assert.equal(allowed.status, 200);
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "https://editor.example"
    );
    assert.match(allowed.headers.get("vary") ?? "", /Origin/);
    assert.equal(allowed.headers.get("access-control-allow-credentials"), null);

    const denied = await fetch(`${baseUrl}/healthz`, {
      headers: { origin: "https://malicious.example" }
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);

    const preflight = await fetch(`${baseUrl}/api/agent/runs`, {
      method: "OPTIONS",
      headers: {
        origin: "https://preview.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type"
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "https://preview.example"
    );
    const allowedMethods = preflight.headers.get("access-control-allow-methods") ?? "";
    const allowedHeaders = preflight.headers.get("access-control-allow-headers") ?? "";
    assert.match(allowedMethods, /POST/);
    assert.match(allowedHeaders, /authorization/i);
    assert.match(allowedHeaders, /content-type/i);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);

    const deniedPreflight = await fetch(`${baseUrl}/api/agent/runs`, {
      method: "OPTIONS",
      headers: {
        origin: "https://malicious.example",
        "access-control-request-method": "POST"
      }
    });
    assert.equal(deniedPreflight.headers.get("access-control-allow-origin"), null);
  });
});

test("requires authentication on every reconnectable endpoint when enabled", async () => {
  await withMockAgentApp({ enabled: true }, async (baseUrl) => {
    const responses = await Promise.all([
      postJson(`${baseUrl}/api/agent/runs`),
      fetch(`${baseUrl}/api/agent/sessions`),
      fetch(`${baseUrl}/api/agent/sessions/session-1`),
      fetch(`${baseUrl}/api/agent/sessions/session-1/presentation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          presentationId: "presentation-1",
          presentationTitle: "Deck"
        })
      }),
      fetch(`${baseUrl}/api/agent/sessions/session-1`, { method: "DELETE" }),
      fetch(`${baseUrl}/api/agent/runs/run-1/events?after=0`),
      fetch(`${baseUrl}/api/agent/runs/run-1/cancel`, { method: "POST" })
    ]);

    for (const response of responses) {
      assert.equal(response.status, 401);
      assert.equal(await readErrorCode(response), "auth_required");
    }
  });
});

test("ignores the development auth bypass in production", async () => {
  await withMockAgentApp({
    enabled: true,
    devAuthBypass: true,
    nodeEnv: "production"
  }, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/agent/runs`);
    assert.equal(response.status, 401);
    assert.equal(await readErrorCode(response), "auth_required");
  });
});

test("runs a multi-turn conversation through the composed mock HTTP API", async () => {
  await withMockAgentApp({ enabled: true, devAuthBypass: true }, async (baseUrl) => {
    const first = await startAgentRun(baseUrl, {
      title: "API lifecycle deck",
      message: "Make the opening slide clearer",
      motionDoc: "# Opening",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key"
    });
    const firstEvents = await subscribeAgentRun(baseUrl, first.runId);
    const firstTerminal = firstEvents.at(-1);

    assert.ok(firstEvents.some(({ kind }) => kind === "activity"));
    assert.ok(firstTerminal?.kind === "result");
    assert.match(firstTerminal.result.motionDoc, /Make the opening slide clearer/);
    assert.equal(firstTerminal.result.baseSourceRevision, "revision-1");

    const replay = await subscribeAgentRun(
      baseUrl,
      first.runId,
      firstTerminal.sequence - 1
    );
    assert.deepEqual(
      replay.map(({ kind, sequence }) => ({ kind, sequence })),
      [{ kind: "result", sequence: firstTerminal.sequence }]
    );

    const firstState = await readAgentSession(baseUrl, first.session.id);
    assert.equal(firstState.activeRun, null);
    assert.equal(firstState.session.latestMotionDoc, firstTerminal.result.motionDoc);
    assert.deepEqual(
      firstState.session.messages.map(({ role }) => role),
      ["user", "assistant"]
    );

    const second = await startAgentRun(baseUrl, {
      sessionId: first.session.id,
      message: "Make the title more concise",
      motionDoc: firstTerminal.result.motionDoc,
      sourceRevision: "revision-2",
      llmApiKey: "test-api-key"
    });
    assert.equal(second.session.id, first.session.id);
    const secondEvents = await subscribeAgentRun(baseUrl, second.runId);
    const secondTerminal = secondEvents.at(-1);
    assert.ok(secondTerminal?.kind === "result");
    assert.match(secondTerminal.result.motionDoc, /Make the title more concise/);

    const secondState = await readAgentSession(baseUrl, first.session.id);
    assert.deepEqual(
      secondState.session.messages.map(({ role }) => role),
      ["user", "assistant", "user", "assistant"]
    );
    assert.equal(secondState.session.latestMotionDoc, secondTerminal.result.motionDoc);

    const reset = await fetch(`${baseUrl}/api/agent/sessions/${first.session.id}`, {
      method: "DELETE"
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { reset: true });

    const missing = await fetch(`${baseUrl}/api/agent/sessions/${first.session.id}`);
    assert.equal(missing.status, 404);
    assert.equal(await readErrorCode(missing), "session_not_found");
  });
});

test("lists a bounded presentation-aware catalog with stable cursor pagination", async () => {
  await withMockAgentApp({ enabled: true, devAuthBypass: true }, async (baseUrl) => {
    const first = await startAgentRun(baseUrl, {
      message: "Create the first conversation",
      motionDoc: "# First",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key",
      presentationId: "presentation-1",
      presentationTitle: "First deck"
    });
    await subscribeAgentRun(baseUrl, first.runId);

    const second = await startAgentRun(baseUrl, {
      message: "Create the second conversation",
      motionDoc: "# Second",
      sourceRevision: "revision-2",
      llmApiKey: "test-api-key",
      presentationId: "presentation-2",
      presentationTitle: "Second deck"
    });
    await subscribeAgentRun(baseUrl, second.runId);

    const firstPageResponse = await fetch(`${baseUrl}/api/agent/sessions?limit=1`);
    assert.equal(firstPageResponse.status, 200);
    const firstPage = AgentSessionPageSchema.parse(await firstPageResponse.json());
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0]?.id, second.session.id);
    assert.deepEqual(firstPage.items[0]?.presentation, {
      id: "presentation-2",
      title: "Second deck"
    });
    assert.equal(firstPage.items[0]?.messageCount, 2);
    assert.ok(firstPage.nextCursor);
    assert.equal("userId" in (firstPage.items[0] ?? {}), false);
    assert.equal("latestMotionDoc" in (firstPage.items[0] ?? {}), false);

    const secondPageResponse = await fetch(
      `${baseUrl}/api/agent/sessions?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`
    );
    assert.equal(secondPageResponse.status, 200);
    const secondPage = AgentSessionPageSchema.parse(await secondPageResponse.json());
    assert.deepEqual(secondPage.items.map(({ id }) => id), [first.session.id]);
    assert.equal(secondPage.nextCursor, undefined);

    const malformed = await fetch(`${baseUrl}/api/agent/sessions?cursor=not-a-cursor`);
    assert.equal(malformed.status, 400);
    assert.equal(await readErrorCode(malformed), "invalid_request");
  });
});

test("refuses to rebind a conversation to another presentation", async () => {
  await withMockAgentApp({ enabled: true, devAuthBypass: true }, async (baseUrl) => {
    const first = await startAgentRun(baseUrl, {
      message: "Create a bound conversation",
      motionDoc: "# First",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key",
      presentationId: "presentation-1",
      presentationTitle: "First deck"
    });
    await subscribeAgentRun(baseUrl, first.runId);

    const response = await requestAgentRun(baseUrl, {
      sessionId: first.session.id,
      message: "Try another deck",
      motionDoc: "# Second",
      sourceRevision: "revision-2",
      llmApiKey: "test-api-key",
      presentationId: "presentation-2",
      presentationTitle: "Second deck"
    });
    assert.equal(response.status, 400);
    assert.equal(await readErrorCode(response), "invalid_request");
  });
});

test("rejects an overlapping turn and cancels the accepted run through HTTP", async () => {
  await withMockAgentApp({ enabled: true, devAuthBypass: true }, async (baseUrl) => {
    const first = await startAgentRun(baseUrl, {
      title: "Cancellation deck",
      message: "Start a long update",
      motionDoc: "# Opening",
      sourceRevision: "revision-1",
      llmApiKey: "test-api-key"
    });
    const conflict = await requestAgentRun(baseUrl, {
      sessionId: first.session.id,
      message: "Overlap the active update",
      motionDoc: "# Opening",
      sourceRevision: "revision-2",
      llmApiKey: "test-api-key"
    });
    assert.equal(conflict.status, 409);
    assert.equal(await readErrorCode(conflict), "active_run_conflict");

    const cancellation = await fetch(
      `${baseUrl}/api/agent/runs/${first.runId}/cancel`,
      { method: "POST" }
    );
    assert.equal(cancellation.status, 200);
    assert.deepEqual(await cancellation.json(), { cancelled: true });

    const events = await subscribeAgentRun(baseUrl, first.runId);
    assert.equal(events.at(-1)?.kind, "cancelled");
    const state = await readAgentSession(baseUrl, first.session.id);
    assert.deepEqual(
      state.session.messages.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "Start a long update" },
        { role: "assistant", content: "Run cancelled." }
      ]
    );
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

test("reads and resets authenticated conversation state", async () => {
  const session = createSession();
  let resetSessionId: string | undefined;
  const app = createRouteApp({
    getSessionState: async (_userId: string, sessionId: string) => ({
      session: { ...session, id: sessionId },
      activeRun: { runId: "run-1", acceptedAt: "2026-07-11T00:00:00.000Z" }
    }),
    resetSession: async (_userId: string, sessionId: string) => {
      resetSessionId = sessionId;
      return { reset: true as const };
    }
  });

  await withHttpServer(app, async (baseUrl) => {
    const stateResponse = await fetch(`${baseUrl}/api/agent/sessions/session-1`);
    assert.equal(stateResponse.status, 200);
    assert.deepEqual(await stateResponse.json(), {
      session,
      activeRun: { runId: "run-1", acceptedAt: "2026-07-11T00:00:00.000Z" }
    });

    const resetResponse = await fetch(`${baseUrl}/api/agent/sessions/session-1`, {
      method: "DELETE"
    });
    assert.equal(resetResponse.status, 200);
    assert.deepEqual(await resetResponse.json(), { reset: true });
    assert.equal(resetSessionId, "session-1");
  });
});

test("attaches a legacy conversation to one presentation", async () => {
  const session = createSession();
  let attached:
    | { userId: string; sessionId: string; presentationId: string; presentationTitle: string }
    | undefined;
  const app = createRouteApp({
    attachSessionToPresentation: async (userId, sessionId, input) => {
      attached = { userId, sessionId, ...input };
      return {
        ...session,
        presentationId: input.presentationId,
        presentationTitle: input.presentationTitle
      };
    }
  });

  await withHttpServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/agent/sessions/session-1/presentation`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          presentationId: "presentation-1",
          presentationTitle: "Deck"
        })
      }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(attached, {
      userId: "user-1",
      sessionId: "session-1",
      presentationId: "presentation-1",
      presentationTitle: "Deck"
    });
  });
});

test("returns stable 404, 409, 400, and sanitized 500 errors", async () => {
  const app = createRouteApp({
    getSessionState: async () => {
      throw new SlideXAgentRunServiceError("session_not_found", "Conversation not found");
    },
    start: async () => {
      throw new SlideXAgentRunServiceError(
        "active_run_conflict",
        "An agent run is already in progress for this conversation"
      );
    },
    cancel: () => {
      throw new Error("private provider detail");
    }
  });

  await withHttpServer(app, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/agent/sessions/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: { code: "session_not_found", message: "Conversation not found" }
    });

    const conflict = await fetch(`${baseUrl}/api/agent/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        presentationId: "presentation-1",
        presentationTitle: "Test deck",
        message: "Update it",
        motionDoc: "# Deck",
        sourceRevision: "revision-1",
        llmApiKey: "test-api-key"
      })
    });
    assert.equal(conflict.status, 409);
    assert.equal(await readErrorCode(conflict), "active_run_conflict");

    const invalidCursor = await fetch(`${baseUrl}/api/agent/runs/run-1/events?after=nope`);
    assert.equal(invalidCursor.status, 400);
    assert.equal(await readErrorCode(invalidCursor), "invalid_request");

    const internal = await fetch(`${baseUrl}/api/agent/runs/run-1/cancel`, { method: "POST" });
    assert.equal(internal.status, 500);
    const internalBody = await internal.json();
    assert.deepEqual(internalBody, {
      error: {
        code: "internal_error",
        message: "The agent service could not complete the request"
      }
    });
    assert.doesNotMatch(JSON.stringify(internalBody), /private provider detail/);
  });
});

function toAsyncIterable(events: AgentRunEvent[]): AsyncIterable<AgentRunEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    }
  };
}

function createRouteApp(service: Partial<SlideXAgentRunService>) {
  const deps = {
    authService: {
      requireUserFromRequest: async () => ({ id: "user-1" })
    } as unknown as AuthService,
    agentRunService: service as SlideXAgentRunService
  } satisfies AgentRunRouteDeps;
  const app = express();
  app.use(express.json());
  app.post("/api/agent/runs", createStartAgentRunHandler(deps));
  app.get("/api/agent/runs/:runId/events", createSubscribeAgentRunHandler(deps));
  app.post("/api/agent/runs/:runId/cancel", createCancelAgentRunHandler(deps));
  app.get("/api/agent/sessions/:sessionId", createGetAgentSessionHandler(deps));
  app.put(
    "/api/agent/sessions/:sessionId/presentation",
    createAttachAgentSessionHandler(deps)
  );
  app.delete("/api/agent/sessions/:sessionId", createResetAgentSessionHandler(deps));
  return app;
}

function createSession(): Session {
  return {
    id: "session-1",
    userId: "user-1",
    title: "Deck",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    latestMotionDoc: "# Deck",
    messages: []
  };
}

async function withHttpServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
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
  }
}

function parseSseFrames(text: string) {
  return parseSseEvents(text)
    .map((payload) => ({
      event: payload.kind,
      id: String(payload.sequence),
      kind: payload.kind,
      sequence: payload.sequence
    }));
}

function parseSseEvents(text: string): AgentRunEvent[] {
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
      const payload = AgentRunEventSchema.parse(JSON.parse(data));
      assert.equal(event, payload.kind);
      assert.equal(id, String(payload.sequence));
      return payload;
    });
}

async function withMockAgentApp(
  options: {
    enabled: boolean;
    corsOrigin?: string;
    devAuthBypass?: boolean;
    nodeEnv?: Env["NODE_ENV"];
  },
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slidex-agent-app-"));
  const env: Env = {
    NODE_ENV: options.nodeEnv ?? "test",
    PORT: 3000,
    AGENT_DRIVER: "mock",
    HEDDLE_SESSION_STORAGE: "file",
    SLIDEX_PRODUCT_SESSION_STORAGE: "file",
    SLIDEX_AGENT_ENABLED: options.enabled,
    DEFAULT_MODEL: "gpt-test",
    CORS_ORIGIN: options.corsOrigin ?? (
      options.nodeEnv === "production" && options.enabled
        ? "https://editor.example"
        : undefined
    ),
    LOG_LEVEL: "silent",
    SHUTDOWN_GRACE_MS: 30_000,
    DEV_AUTH_BYPASS: options.devAuthBypass ? "1" : undefined,
    DEV_USER_ID: "api-test-user",
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

async function startAgentRun(
  baseUrl: string,
  input: AgentRunTestInput
) {
  const response = await requestAgentRun(baseUrl, input);
  assert.equal(response.status, 202);
  return StartAgentRunResultSchema.parse(await response.json());
}

function requestAgentRun(
  baseUrl: string,
  input: AgentRunTestInput
): Promise<Response> {
  return fetch(`${baseUrl}/api/agent/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      presentationId: "presentation-1",
      presentationTitle: "Test deck",
      ...input
    } satisfies StartAgentRunInput)
  });
}

type AgentRunTestInput = Omit<
  StartAgentRunInput,
  "presentationId" | "presentationTitle"
> & Partial<Pick<StartAgentRunInput, "presentationId" | "presentationTitle">>;

async function subscribeAgentRun(
  baseUrl: string,
  runId: string,
  afterSequence = 0
): Promise<AgentRunEvent[]> {
  const response = await fetch(
    `${baseUrl}/api/agent/runs/${runId}/events?after=${afterSequence}`
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  return parseSseEvents(await response.text());
}

async function readAgentSession(baseUrl: string, sessionId: string) {
  const response = await fetch(`${baseUrl}/api/agent/sessions/${sessionId}`);
  assert.equal(response.status, 200);
  return AgentSessionStateSchema.parse(await response.json());
}

function postJson(url: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  const body = await response.json() as { error?: { code?: string } };
  return body.error?.code;
}
