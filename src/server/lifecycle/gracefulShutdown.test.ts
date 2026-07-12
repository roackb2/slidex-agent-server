import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  createGracefulShutdown,
  type ShutdownLogger
} from "./gracefulShutdown.js";

test("stops accepting connections and waits for an active request", async () => {
  let releaseResponse: (() => void) | undefined;
  let markRequestStarted: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const server = createServer(async (_request, response) => {
    markRequestStarted?.();
    await responseReleased;
    response.end("done");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const fixture = createFixture(server, 5_000);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = fetch(`http://127.0.0.1:${address.port}/slow`);
  await requestStarted;
  const firstShutdown = fixture.shutdown("SIGTERM");
  const repeatedShutdown = fixture.shutdown("SIGINT");

  assert.strictEqual(firstShutdown, repeatedShutdown);
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}/new`));
  assert.deepEqual(fixture.exitCodes, []);
  releaseResponse?.();

  const completedResponse = await response;
  assert.equal(completedResponse.status, 200);
  assert.equal(await completedResponse.text(), "done");
  await firstShutdown;
  assert.deepEqual(fixture.exitCodes, [0]);
  assert.equal(fixture.stopCount(), 1);
  assert.deepEqual(fixture.events(), [
    "server.shutdown_started",
    "server.shutdown_completed"
  ]);
});

test("force-closes an active response after the drain deadline", async () => {
  let markRequestStarted: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.write("still running");
    markRequestStarted?.();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const fixture = createFixture(server, 10);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/never-finishes`);
  await requestStarted;
  await fixture.shutdown("SIGTERM");

  await assert.rejects(response.text());
  assert.deepEqual(fixture.exitCodes, [0]);
  assert.deepEqual(fixture.events(), [
    "server.shutdown_started",
    "server.shutdown_completed"
  ]);
  assert.ok(Number(fixture.records.at(-1)?.fields.durationMs) >= 9);
});

test("reports resource cleanup failure without logging its message", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const fixture = createFixture(server, 1_000, async () => {
    throw new Error("sensitive subprocess details");
  });

  await fixture.shutdown("SIGINT");

  assert.deepEqual(fixture.exitCodes, [1]);
  assert.equal(fixture.records.at(-2)?.fields.errorType, "Error");
  assert.doesNotMatch(JSON.stringify(fixture.records), /sensitive subprocess details/);
});

function createFixture(
  server: ReturnType<typeof createServer>,
  graceMs: number,
  stopResources: () => Promise<void> = async () => undefined
) {
  const records: Array<{
    level: "info" | "error";
    fields: Record<string, unknown>;
    message: string;
  }> = [];
  const logger: ShutdownLogger = {
    info: (fields, message) => records.push({ level: "info", fields, message }),
    error: (fields, message) => records.push({ level: "error", fields, message })
  };
  const exitCodes: Array<0 | 1> = [];
  let stopped = 0;
  const shutdown = createGracefulShutdown({
    server,
    logger,
    graceMs,
    stopResources: async () => {
      stopped += 1;
      await stopResources();
    },
    exit: (code) => {
      exitCodes.push(code);
    }
  });

  return {
    shutdown,
    records,
    exitCodes,
    stopCount: () => stopped,
    events: () => records.map(({ fields }) => fields.event)
  };
}
