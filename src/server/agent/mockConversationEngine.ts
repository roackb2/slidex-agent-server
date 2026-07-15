import {
  HeddleEventType,
  type ConversationActivity,
  type ConversationEngine,
  type ConversationTurnResultSummary,
  type SubmitConversationTurnInput
} from "@roackb2/heddle";
import type { AuthUser } from "../auth.js";
import type { Env } from "../env.js";
import { createMockDriver } from "./mockDriver.js";
import type { AgentProgressEvent } from "./types.js";

type CreateMockConversationEngineInput = {
  user: AuthUser;
  sessionId: string;
  llmApiKey: string;
  model: string;
  motionDoc: string;
  message: string;
};

/**
 * Adapts the existing deterministic mock driver to the ConversationEngine
 * surface consumed by SlideXAgentRunService. The product run service therefore
 * exercises the same Heddle run identity, replay, cancellation, persistence,
 * and HTTP/SSE path in mock and real modes; only model/tool execution differs.
 */
export async function createMockConversationEngine(
  _env: Env,
  input: CreateMockConversationEngineInput
): Promise<ConversationEngine> {
  const sessions = new Map<string, { id: string; model?: string }>();
  let currentArtifact: { id: string; content: string } | undefined;
  const driver = createMockDriver();

  return {
    sessions: {
      readExisting: async (id: string) => sessions.get(id),
      create: async (sessionInput: { id?: string; model?: string } = {}) => {
        const session = {
          id: sessionInput.id ?? `mock-${input.sessionId}`,
          model: sessionInput.model
        };
        sessions.set(session.id, session);
        return session;
      },
      updateSettings: async (id: string, settings: { model?: string }) => {
        const session = { ...sessions.get(id), id, model: settings.model };
        sessions.set(id, session);
        return session;
      }
    },
    turns: {
      submit: async (turn: SubmitConversationTurnInput) => {
        let streamedText = "";
        const result = await driver.run({
          user: input.user,
          sessionId: input.sessionId,
          motionDoc: input.motionDoc,
          message: input.message,
          llmApiKey: input.llmApiKey,
          model: input.model,
          signal: turn.abortSignal ?? new AbortController().signal,
          emit: (event) => {
            if (event.type === "motionDoc") {
              currentArtifact = {
                id: `mock-motiondoc-${Date.now()}`,
                content: event.motionDoc
              };
              return;
            }
            if (event.type === "token") {
              streamedText += event.text;
            }
            const activity = toConversationActivity(event, streamedText);
            if (activity) {
              turn.host?.events?.onActivity?.(activity);
            }
          }
        });

        return {
          outcome: "complete",
          summary: result.assistantMessage || streamedText.trim(),
          session: {} as ConversationTurnResultSummary["session"],
          artifacts: [],
          toolResults: [createMockValidationToolResult(result.motionDoc)]
        } satisfies ConversationTurnResultSummary;
      }
    },
    artifacts: {
      current: () => currentArtifact ? { id: currentArtifact.id } : undefined,
      read: (id: string) => currentArtifact?.id === id
        ? { content: currentArtifact.content }
        : undefined
    }
  } as unknown as ConversationEngine;
}

function createMockValidationToolResult(
  motionDoc: string
): ConversationTurnResultSummary["toolResults"][number] {
  return {
    call: {
      id: "mock-validate-final-motiondoc",
      tool: "slidex_validate_motion_doc",
      input: { source: motionDoc }
    },
    result: {
      ok: true,
      output: {
        isError: false,
        structuredContent: {
          result: { isValid: true, issues: [] }
        }
      }
    },
    durationMs: 0,
    step: 1,
    timestamp: new Date().toISOString()
  };
}

function toConversationActivity(
  event: AgentProgressEvent,
  streamedText: string
): ConversationActivity | undefined {
  const timestamp = new Date().toISOString();
  if (event.type === "token") {
    return {
      source: "agent-loop",
      type: HeddleEventType.assistantStream,
      runId: "mock-agent",
      step: 1,
      text: streamedText,
      done: false,
      timestamp
    };
  }
  if (event.type === "tool" && event.status === "started") {
    return {
      source: "agent-loop",
      type: HeddleEventType.toolCalling,
      runId: "mock-agent",
      step: 1,
      tool: event.name,
      toolCallId: `mock-${event.name}`,
      input: {},
      requiresApproval: false,
      timestamp
    };
  }
  if (event.type === "tool") {
    return {
      source: "agent-loop",
      type: HeddleEventType.toolCompleted,
      runId: "mock-agent",
      step: 1,
      tool: event.name,
      toolCallId: `mock-${event.name}`,
      result: { ok: event.status === "completed" },
      durationMs: 0,
      timestamp
    };
  }
  return undefined;
}
