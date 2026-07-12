import assert from "node:assert/strict";
import { once } from "node:events";
import { Writable } from "node:stream";
import test from "node:test";
import express from "express";
import type { Env } from "../env.js";
import { createHttpLogger, createServerLogger } from "./logger.js";

test("redacts credentials even when a future caller logs request-shaped fields", () => {
  const output = captureLogs();
  const logger = createServerLogger(createTestEnv(), output.destination);

  logger.info({
    req: {
      headers: {
        authorization: "Bearer request-secret",
        cookie: "session=request-secret"
      },
      body: { llmApiKey: "model-secret" }
    },
    llmApiKey: "top-level-secret"
  }, "Redaction check");

  const serialized = output.lines.join("");
  assert.doesNotMatch(serialized, /request-secret|model-secret|top-level-secret/);
  assert.match(serialized, /\[Redacted\]/);
});

test("adds one request ID and emits compact structured HTTP completion data", async () => {
  const output = captureLogs();
  const logger = createServerLogger(createTestEnv(), output.destination);
  const app = express();
  app.use(createHttpLogger(logger));
  app.get("/healthz", (_request, response) => response.json({ ok: true }));
  const server = app.listen(0);
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`, {
      headers: { authorization: "Bearer request-secret" }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const requestId = response.headers.get("x-request-id");
    assert.match(requestId ?? "", /^[0-9a-f-]{36}$/);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const entry = output.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(({ msg }) => msg === "HTTP request completed");
    assert.ok(entry);
    assert.equal(entry.component, "http");
    assert.equal(entry.reqId, requestId);
    const loggedRequest = entry.req as Record<string, unknown>;
    assert.deepEqual({
      id: loggedRequest.id,
      method: loggedRequest.method,
      url: loggedRequest.url
    }, {
      id: requestId,
      method: "GET",
      url: "/healthz"
    });
    assert.match(String(loggedRequest.remoteAddress), /127\.0\.0\.1$/);
    assert.deepEqual(entry.res, { statusCode: 200 });
    assert.doesNotMatch(JSON.stringify(entry), /request-secret|authorization/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

function captureLogs(): {
  destination: Writable;
  lines: string[];
} {
  const lines: string[] = [];
  return {
    lines,
    destination: new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      }
    })
  };
}

function createTestEnv(): Env {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    AGENT_DRIVER: "mock",
    SLIDEX_AGENT_ENABLED: false,
    DEFAULT_MODEL: "gpt-test",
    LOG_LEVEL: "info",
    SHUTDOWN_GRACE_MS: 30_000,
    dataDir: "/tmp/slidex-agent-logger-test"
  };
}
