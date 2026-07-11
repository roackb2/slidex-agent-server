import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import type { AuthService } from "../auth.js";
import type { SlideXAgentRunService } from "../agent/slidexAgentRunService.js";
import type { AgentRunEvent } from "../../shared/schema.js";
import {
  createSubscribeAgentRunHandler,
  type AgentRunRouteDeps
} from "./agentRuns.js";

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
