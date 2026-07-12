import type { ConversationEngine } from "@roackb2/heddle";
import {
  ConversationRunConflictError,
  ConversationRunReplayUnavailableError,
  ConversationRunService,
  type ConversationRunHandle
} from "@roackb2/heddle/hosted";
import type {
  AgentApiErrorCode,
  AgentRunEvent,
  AgentSessionState,
  Session,
  StartAgentRunInput
} from "../../shared/schema.js";
import type { AuthUser } from "../auth.js";
import type { Env } from "../env.js";
import { makeMessage, type SessionStore } from "../storage/sessionStore.js";
import { createSlideXConversationEngine } from "./heddleDriver.js";
import { createMockConversationEngine } from "./mockConversationEngine.js";
import {
  buildPrompt,
  createSlideXApprovalHost,
  resolveConversationSession,
  resolveMotionDoc
} from "./slidexHeddleAgent.js";

type SlideXRunAddress = {
  userId: string;
  sessionId: string;
};

type SlideXRunResult = {
  session: Session;
  motionDoc: string;
  assistantMessage: string;
  baseSourceRevision: string;
};

class SlideXAgentSessionResetError extends Error {}
class SlideXAgentResultFinalizationError extends Error {}

type CreateEngine = (
  env: Env,
  input: {
    user: AuthUser;
    sessionId: string;
    llmApiKey: string;
    model: string;
    motionDoc: string;
    message: string;
  }
) => Promise<ConversationEngine>;

export type AgentRunLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
};

const NOOP_LOGGER: AgentRunLogger = {
  info: () => undefined,
  warn: () => undefined
};

export type SlideXAgentRunServiceOptions = {
  env: Env;
  sessionStore: SessionStore;
  createEngine?: CreateEngine;
  logger?: AgentRunLogger;
};

export class SlideXAgentRunServiceError extends Error {
  constructor(
    readonly code: AgentApiErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SlideXAgentRunServiceError";
  }
}

/**
 * Owns SlideX's product-level run lifecycle around Heddle's generic run service.
 *
 * Heddle owns execution, cancellation, ordered activities, and replay. This
 * service owns user/session authorization, MotionDoc seeding/finalization, and
 * durable SlideX chat history. HTTP/SSE concerns remain in the route layer.
 */
export class SlideXAgentRunService {
  private readonly runs = new ConversationRunService<SlideXRunAddress>({
    addressKey: ({ userId, sessionId }) => `${userId}:${sessionId}`,
    replay: { maxEventsPerRun: 512, retentionMs: 5 * 60_000 }
  });
  private readonly resetAddresses = new Set<string>();
  private readonly createEngine: CreateEngine;
  private readonly logger: AgentRunLogger;

  constructor(private readonly options: SlideXAgentRunServiceOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.createEngine = options.createEngine
      ?? (options.env.AGENT_DRIVER === "mock"
        ? createMockConversationEngine
        : createSlideXConversationEngine);
  }

  async start(
    user: AuthUser,
    input: StartAgentRunInput,
    observability: { correlationId?: string } = {}
  ) {
    const startedAt = Date.now();
    const correlation = observability.correlationId
      ? { correlationId: observability.correlationId }
      : {};
    const session = await this.resolveProductSession(user.id, input);
    const address = { userId: user.id, sessionId: session.id };
    if (this.runs.isRunning(address)) {
      throw new SlideXAgentRunServiceError(
        "active_run_conflict",
        "An agent run is already in progress for this conversation"
      );
    }
    const model = input.model || this.options.env.DEFAULT_MODEL;
    const engine = await this.createEngine(this.options.env, {
      user,
      sessionId: session.id,
      llmApiKey: input.llmApiKey,
      model,
      motionDoc: input.motionDoc,
      message: input.message
    });
    const conversation = resolveConversationSession(engine, session.id, model);
    const previousArtifactId = engine.artifacts.current(conversation.id)?.id;

    const key = addressKey(address);
    let acceptedSession: Promise<Session>;
    let run: ConversationRunHandle<SlideXRunAddress, SlideXRunResult>;
    try {
      run = this.runs.startTurn({
        address,
        engine,
        turn: {
          sessionId: conversation.id,
          prompt: buildPrompt(input),
          maxSteps: 24,
          host: createSlideXApprovalHost()
        },
        projectResult: async (turnResult, runContext) => {
          if (this.resetAddresses.has(key)) {
            throw new SlideXAgentSessionResetError();
          }
          try {
            const currentSession = await acceptedSession;
            const motionDoc = resolveMotionDoc(
              engine,
              conversation.id,
              previousArtifactId,
              input.motionDoc
            );
            currentSession.latestMotionDoc = motionDoc;
            currentSession.messages.push(
              makeMessage({
                role: "assistant",
                content: turnResult.summary,
                metadata: {
                  outcome: turnResult.outcome,
                  runId: runContext.runId,
                  toolCalls: turnResult.toolResults.length
                }
              })
            );
            const persistedSession = await this.options.sessionStore.writeSession(currentSession);
            this.logger.info({
              event: "agent_run.terminal",
              runId: runContext.runId,
              sessionId: session.id,
              model,
              outcome: turnResult.outcome,
              durationMs: Date.now() - startedAt,
              toolCallCount: turnResult.toolResults.length,
              ...correlation
            }, "Agent run completed");
            return {
              session: persistedSession,
              motionDoc,
              assistantMessage: turnResult.summary,
              baseSourceRevision: input.sourceRevision
            };
          } catch {
            throw new SlideXAgentResultFinalizationError();
          }
        },
        onError: async (error, runContext) => {
          const cancelled = runContext.controller.signal.aborted;
          await this.persistTerminalFailure({
            acceptedSession,
            addressKey: key,
            runId: runContext.runId,
            cancelled
          });
          const fields = {
            event: "agent_run.terminal",
            runId: runContext.runId,
            sessionId: session.id,
            model,
            outcome: cancelled ? "cancelled" : "error",
            durationMs: Date.now() - startedAt,
            ...correlation
          };
          if (cancelled) {
            this.logger.info(fields, "Agent run cancelled");
          } else if (error instanceof SlideXAgentResultFinalizationError) {
            this.logger.warn(fields, "Agent run result finalization failed");
          } else {
            this.logger.warn(fields, "Agent run failed");
          }
        },
        projectError: (error) => error instanceof SlideXAgentResultFinalizationError
          ? {
              code: "finalization_failed",
              message: "The agent finished, but its deck result could not be saved"
            }
          : {
              code: "run_failed",
              message: "The agent could not complete this request. Try again."
            },
        onSettled: () => {
          this.resetAddresses.delete(key);
        }
      });
    } catch (error) {
      if (error instanceof ConversationRunConflictError) {
        throw new SlideXAgentRunServiceError(
          "active_run_conflict",
          "An agent run is already in progress for this conversation"
        );
      }
      throw error;
    }

    acceptedSession = this.persistAcceptedMessage(session, input, run.runId)
      .then((persistedSession) => {
        this.logger.info({
          event: "agent_run.accepted",
          runId: run.runId,
          sessionId: session.id,
          model,
          ...correlation
        }, "Agent run accepted");
        return persistedSession;
      });

    try {
      const persistedSession = await acceptedSession;
      return {
        accepted: true as const,
        runId: run.runId,
        acceptedAt: run.acceptedAt,
        session: persistedSession
      };
    } catch (error) {
      run.cancel();
      throw error;
    }
  }

  subscribe(input: {
    userId: string;
    runId: string;
    afterSequence?: number;
    signal?: AbortSignal;
  }): AsyncIterable<AgentRunEvent> {
    const run = this.requireOwnedRun(input.userId, input.runId);
    try {
      return run.events({
        afterSequence: input.afterSequence,
        signal: input.signal
      });
    } catch (error) {
      if (error instanceof ConversationRunReplayUnavailableError) {
        throw new SlideXAgentRunServiceError(
          "replay_unavailable",
          "Live agent progress is no longer available; refresh the conversation history"
        );
      }
      throw error;
    }
  }

  async getSessionState(userId: string, sessionId: string): Promise<AgentSessionState> {
    const session = await this.requireProductSession(userId, sessionId);
    const activeRun = this.runs.getActiveRun({ userId, sessionId });
    return {
      session,
      activeRun: activeRun
        ? { runId: activeRun.runId, acceptedAt: activeRun.acceptedAt }
        : null
    };
  }

  async resetSession(userId: string, sessionId: string): Promise<{ reset: true }> {
    await this.requireProductSession(userId, sessionId);
    const address = { userId, sessionId };
    const key = addressKey(address);
    const activeRun = this.runs.getActiveRun(address);
    this.resetAddresses.add(key);

    if (activeRun) {
      const cancelled = this.runs.cancelRun(address, activeRun.runId);
      if (!cancelled) {
        this.resetAddresses.delete(key);
      }
    }

    try {
      await this.options.sessionStore.deleteSession(userId, sessionId);
      this.logger.info({
        event: "agent_session.reset",
        sessionId,
        cancelledRunId: activeRun?.runId
      }, "Agent conversation reset");
      return { reset: true };
    } catch (error) {
      this.resetAddresses.delete(key);
      throw error;
    } finally {
      if (!activeRun) {
        this.resetAddresses.delete(key);
      }
    }
  }

  cancel(userId: string, runId: string): boolean {
    const run = this.requireOwnedRun(userId, runId);
    const cancelled = run.cancel();
    if (cancelled) {
      this.logger.info({
        event: "agent_run.cancel_requested",
        runId,
        sessionId: run.sessionId
      }, "Agent run cancellation requested");
    }
    return cancelled;
  }

  private async resolveProductSession(userId: string, input: StartAgentRunInput): Promise<Session> {
    if (input.sessionId) {
      return this.requireProductSession(userId, input.sessionId);
    }
    return this.options.sessionStore.createSession({
      userId,
      title: input.title ?? titleFromMessage(input.message),
      motionDoc: input.motionDoc
    });
  }

  private async requireProductSession(userId: string, sessionId: string): Promise<Session> {
    const session = await this.options.sessionStore.getSession(userId, sessionId);
    if (!session) {
      throw new SlideXAgentRunServiceError("session_not_found", "Conversation not found");
    }
    return session;
  }

  private persistAcceptedMessage(
    session: Session,
    input: StartAgentRunInput,
    runId: string
  ): Promise<Session> {
    session.latestMotionDoc = input.motionDoc;
    session.messages.push(makeMessage({
      role: "user",
      content: input.message,
      metadata: { runId }
    }));
    return this.options.sessionStore.writeSession(session);
  }

  private async persistTerminalFailure(input: {
    acceptedSession: Promise<Session>;
    addressKey: string;
    runId: string;
    cancelled: boolean;
  }): Promise<void> {
    if (this.resetAddresses.has(input.addressKey)) {
      return;
    }

    const session = await input.acceptedSession;
    session.messages.push(makeMessage({
      role: "assistant",
      content: input.cancelled
        ? "Run cancelled."
        : "The agent could not complete this request. Try again.",
      metadata: {
        outcome: input.cancelled ? "cancelled" : "error",
        runId: input.runId
      }
    }));
    await this.options.sessionStore.writeSession(session);
  }

  private requireOwnedRun(
    userId: string,
    runId: string
  ): ConversationRunHandle<SlideXRunAddress, SlideXRunResult> {
    const run = this.runs.getRetainedRun<SlideXRunResult>(runId);
    if (!run || run.userId !== userId) {
      throw new SlideXAgentRunServiceError("run_not_found", "Agent run not found");
    }
    return run;
  }
}

function addressKey(address: SlideXRunAddress): string {
  return `${address.userId}:${address.sessionId}`;
}

function titleFromMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled deck";
}
