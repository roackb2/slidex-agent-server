import {
  type ConversationEngine,
  type ConversationTurnResultSummary
} from "@roackb2/heddle";
import {
  ConversationRunService,
  type ConversationRunHandle,
  type ConversationRunStreamItem
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

type SlideXRunContext = {
  address: SlideXRunAddress;
  run: ConversationRunHandle<SlideXRunAddress, ConversationTurnResultSummary>;
  result: Promise<SlideXRunResult>;
};

class SlideXAgentSessionResetError extends Error {}

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
  private readonly contexts = new Map<string, SlideXRunContext>();
  private readonly cancelledRunIds = new Set<string>();
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

    const run = this.runs.startTurn({
      address,
      engine,
      turn: {
        sessionId: conversation.id,
        prompt: buildPrompt(input),
        maxSteps: 24,
        host: createSlideXApprovalHost()
      }
    });

    const acceptedSession = this.persistAcceptedMessage(session, input, run.runId)
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
    const key = addressKey(address);
    const result = run.result
      .then(async (turnResult) => {
        if (this.resetAddresses.has(key)) {
          throw new SlideXAgentSessionResetError(
            "SlideX agent conversation was reset during the run"
          );
        }
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
              runId: run.runId,
              toolCalls: turnResult.toolResults.length
            }
          })
        );
        const persistedSession = await this.options.sessionStore.writeSession(currentSession);
        this.logger.info({
          event: "agent_run.terminal",
          runId: run.runId,
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
      })
      .catch(async (error: unknown) => {
        const cancelled = this.cancelledRunIds.has(run.runId);
        await this.persistTerminalFailure({
          acceptedSession,
          addressKey: key,
          runId: run.runId
        });
        const fields = {
          event: "agent_run.terminal",
          runId: run.runId,
          sessionId: session.id,
          model,
          outcome: cancelled ? "cancelled" : "error",
          durationMs: Date.now() - startedAt,
          ...correlation
        };
        if (cancelled) {
          this.logger.info(fields, "Agent run cancelled");
        } else {
          this.logger.warn(fields, "Agent run failed");
        }
        throw error;
      });
    result.catch(() => undefined);

    this.contexts.set(run.runId, { address, run, result });
    this.expireContext(run.runId, key, result);

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
    const context = this.requireOwnedRun(input.userId, input.runId);
    let events: AsyncIterable<ConversationRunStreamItem<ConversationTurnResultSummary>>;
    try {
      events = context.run.events({
        afterSequence: input.afterSequence,
        signal: input.signal
      });
    } catch (error) {
      if (isReplayUnavailable(error)) {
        throw new SlideXAgentRunServiceError(
          "replay_unavailable",
          "Live agent progress is no longer available; refresh the conversation history"
        );
      }
      throw error;
    }
    return this.mapRunEvents(context, events);
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
      if (cancelled) {
        this.cancelledRunIds.add(activeRun.runId);
      } else {
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

  private async *mapRunEvents(
    context: SlideXRunContext,
    events: AsyncIterable<ConversationRunStreamItem<ConversationTurnResultSummary>>
  ): AsyncIterable<AgentRunEvent> {
    for await (const event of events) {
      if (event.kind === "activity") {
        yield event;
        continue;
      }
      if (event.kind === "result") {
        try {
          const result = await context.result;
          yield {
            kind: "result",
            runId: event.runId,
            sequence: event.sequence,
            timestamp: event.timestamp,
            result
          };
        } catch (error) {
          if (!(error instanceof SlideXAgentSessionResetError)) {
            this.logger.warn({
              event: "agent_run.finalization_failed",
              runId: event.runId,
              sessionId: context.address.sessionId
            }, "Agent run finalization failed");
          }
          yield {
            kind: "error",
            runId: event.runId,
            sequence: event.sequence,
            timestamp: event.timestamp,
            error: {
              code: "finalization_failed",
              message: "The agent finished, but its deck result could not be saved"
            }
          };
        }
        continue;
      }
      if (event.kind === "cancelled") {
        await context.result.catch(() => undefined);
        yield event;
        continue;
      }
      await context.result.catch(() => undefined);
      yield {
        ...event,
        error: {
          code: event.error.code,
          message: "The agent could not complete this request. Try again."
        }
      };
    }
  }

  cancel(userId: string, runId: string): boolean {
    const context = this.requireOwnedRun(userId, runId);
    const cancelled = context.run.cancel();
    if (cancelled) {
      this.cancelledRunIds.add(runId);
      this.logger.info({
        event: "agent_run.cancel_requested",
        runId,
        sessionId: context.address.sessionId
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
  }): Promise<void> {
    if (this.resetAddresses.has(input.addressKey)) {
      return;
    }

    const session = await input.acceptedSession;
    const cancelled = this.cancelledRunIds.has(input.runId);
    session.messages.push(makeMessage({
      role: "assistant",
      content: cancelled
        ? "Run cancelled."
        : "The agent could not complete this request. Try again.",
      metadata: {
        outcome: cancelled ? "cancelled" : "error",
        runId: input.runId
      }
    }));
    await this.options.sessionStore.writeSession(session);
  }

  private requireOwnedRun(userId: string, runId: string): SlideXRunContext {
    const context = this.contexts.get(runId);
    if (!context || context.address.userId !== userId) {
      throw new SlideXAgentRunServiceError("run_not_found", "Agent run not found");
    }
    return context;
  }

  private expireContext(
    runId: string,
    key: string,
    result: Promise<SlideXRunResult>
  ): void {
    void result.finally(() => {
      this.cancelledRunIds.delete(runId);
      this.resetAddresses.delete(key);
      const timer = setTimeout(() => this.contexts.delete(runId), 5 * 60_000);
      timer.unref?.();
    }).catch(() => undefined);
  }
}

function addressKey(address: SlideXRunAddress): string {
  return `${address.userId}:${address.sessionId}`;
}

function isReplayUnavailable(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("older than retained sequence");
}

function titleFromMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled deck";
}
