import type {
  ConversationEngine,
  ModelRunFailureCode,
  SubmitConversationTurnResult
} from "@roackb2/heddle";
import {
  ConversationRunConflictError,
  ConversationRunReplayUnavailableError,
  ConversationRunService,
  type ConversationRunContext,
  type ConversationRunHandle
} from "@roackb2/heddle/hosted";
import type {
  AgentApiErrorCode,
  AgentRunEvent,
  AgentSessionState,
  AttachAgentSessionInput,
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
  projectSlideXTurnResult,
  resolveConversationSession,
  SlideXDeckValidationError
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

type SlideXRunLifecycleContext = {
  acceptedSession?: Promise<Session>;
  addressKey: string;
  conversationId: string;
  correlation: { correlationId?: string };
  engine: ConversationEngine;
  initialMotionDoc: string;
  message: string;
  model: string;
  previousArtifactId?: string;
  session: Session;
  sourceRevision: string;
  startedAt: number;
};

class SlideXAgentSessionResetError extends Error {}
class SlideXAgentResultFinalizationError extends Error {}
class SlideXAgentModelCredentialError extends Error {}
class SlideXAgentModelQuotaError extends Error {}

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

const MODEL_CREDENTIAL_REJECTED = {
  code: "model_credential_rejected",
  message: "OpenAI rejected this API key. Check the key and try again."
} as const;

const MODEL_QUOTA_EXHAUSTED = {
  code: "model_quota_exhausted",
  message: "This OpenAI API key is valid, but it has no available quota. Check the account billing or use a different key, then try again."
} as const;

const DECK_VALIDATION_FAILED = {
  code: "deck_validation_failed",
  message: "The agent produced a deck that did not pass validation, so it was not applied. Try again."
} as const;

const RUN_FAILED = {
  code: "run_failed",
  message: "The agent could not complete this request. Try again."
} as const;

const FINALIZATION_FAILED = {
  code: "finalization_failed",
  message: "The agent finished, but its deck result could not be saved"
} as const;

type SlideXRunPublicError =
  | typeof MODEL_CREDENTIAL_REJECTED
  | typeof MODEL_QUOTA_EXHAUSTED
  | typeof DECK_VALIDATION_FAILED
  | typeof RUN_FAILED
  | typeof FINALIZATION_FAILED;

const MODEL_FAILURE_ERROR_BY_CODE = new Map<
  ModelRunFailureCode,
  new () => Error
>([
  ["authentication", SlideXAgentModelCredentialError],
  ["quota", SlideXAgentModelQuotaError]
]);

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

    const lifecycle: SlideXRunLifecycleContext = {
      addressKey: addressKey(address),
      conversationId: conversation.id,
      correlation,
      engine,
      initialMotionDoc: input.motionDoc,
      message: input.message,
      model,
      previousArtifactId,
      session,
      sourceRevision: input.sourceRevision,
      startedAt
    };
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
        onAccepted: this.handleRunAccepted.bind(this, lifecycle),
        projectResult: this.handleRunResult.bind(this, lifecycle),
        onError: this.handleRunError.bind(this, lifecycle),
        projectError: this.projectRunError.bind(this),
        onSettled: this.handleRunSettled.bind(this, lifecycle)
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

    try {
      const persistedSession = await this.requireAcceptedSession(lifecycle);
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

  /**
   * Immutably associates legacy product sessions with their canonical
   * presentation. Repeated calls may refresh the display title, but a session
   * can never be rebound to another presentation.
   */
  async attachSessionToPresentation(
    userId: string,
    sessionId: string,
    input: AttachAgentSessionInput
  ): Promise<Session> {
    const session = await this.requireProductSession(userId, sessionId);
    if (session.presentationId && session.presentationId !== input.presentationId) {
      throw new SlideXAgentRunServiceError(
        "invalid_request",
        "Conversation belongs to a different presentation"
      );
    }
    if (
      session.presentationId === input.presentationId
      && session.presentationTitle === input.presentationTitle
    ) {
      return session;
    }
    return this.options.sessionStore.writeSession({
      ...session,
      presentationId: input.presentationId,
      presentationTitle: input.presentationTitle
    });
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
      return this.attachSessionToPresentation(userId, input.sessionId, {
        presentationId: input.presentationId,
        presentationTitle: input.presentationTitle
      });
    }
    return this.options.sessionStore.createSession({
      userId,
      title: titleFromMessage(input.message),
      motionDoc: input.motionDoc,
      presentationId: input.presentationId,
      presentationTitle: input.presentationTitle
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
    input: { message: string; motionDoc: string },
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

  private handleRunAccepted(
    lifecycle: SlideXRunLifecycleContext,
    runContext: ConversationRunContext
  ): void {
    lifecycle.acceptedSession = this.persistAcceptedMessage(
      lifecycle.session,
      {
        message: lifecycle.message,
        motionDoc: lifecycle.initialMotionDoc
      },
      runContext.runId
    ).then((persistedSession) => {
      this.logger.info({
        event: "agent_run.accepted",
        runId: runContext.runId,
        sessionId: lifecycle.session.id,
        model: lifecycle.model,
        ...lifecycle.correlation
      }, "Agent run accepted");
      return persistedSession;
    });
  }

  private async handleRunResult(
    lifecycle: SlideXRunLifecycleContext,
    turnResult: SubmitConversationTurnResult,
    runContext: ConversationRunContext
  ): Promise<SlideXRunResult> {
    if (this.resetAddresses.has(lifecycle.addressKey)) {
      throw new SlideXAgentSessionResetError();
    }
    if (turnResult.failure?.source === "model") {
      const ModelFailureError = MODEL_FAILURE_ERROR_BY_CODE.get(turnResult.failure.code);
      if (ModelFailureError) {
        throw new ModelFailureError();
      }
    }
    if (turnResult.failure || turnResult.outcome === "error") {
      throw new Error("Agent run returned an error outcome");
    }

    try {
      const currentSession = await this.requireAcceptedSession(lifecycle);
      const { motionDoc, assistantMessage } = projectSlideXTurnResult({
        engine: lifecycle.engine,
        sessionId: lifecycle.conversationId,
        previousArtifactId: lifecycle.previousArtifactId,
        initialMotionDoc: lifecycle.initialMotionDoc,
        result: turnResult
      });
      currentSession.latestMotionDoc = motionDoc;
      currentSession.messages.push(
        makeMessage({
          role: "assistant",
          content: assistantMessage,
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
        sessionId: lifecycle.session.id,
        model: lifecycle.model,
        outcome: turnResult.outcome,
        durationMs: Date.now() - lifecycle.startedAt,
        toolCallCount: turnResult.toolResults.length,
        ...lifecycle.correlation
      }, "Agent run completed");
      return {
        session: persistedSession,
        motionDoc,
        assistantMessage,
        baseSourceRevision: lifecycle.sourceRevision
      };
    } catch (error) {
      if (error instanceof SlideXDeckValidationError) {
        throw error;
      }
      throw new SlideXAgentResultFinalizationError();
    }
  }

  private async handleRunError(
    lifecycle: SlideXRunLifecycleContext,
    error: unknown,
    runContext: ConversationRunContext
  ): Promise<void> {
    const cancelled = runContext.controller.signal.aborted;
    const publicError = cancelled ? undefined : this.projectRunError(error);
    await this.persistTerminalFailure({
      acceptedSession: this.requireAcceptedSession(lifecycle),
      addressKey: lifecycle.addressKey,
      runId: runContext.runId,
      cancelled,
      publicError
    });
    const fields = {
      event: "agent_run.terminal",
      runId: runContext.runId,
      sessionId: lifecycle.session.id,
      model: lifecycle.model,
      outcome: cancelled ? "cancelled" : "error",
      ...(publicError ? { errorCode: publicError.code } : {}),
      durationMs: Date.now() - lifecycle.startedAt,
      ...lifecycle.correlation
    };
    if (cancelled) {
      this.logger.info(fields, "Agent run cancelled");
    } else if (error instanceof SlideXAgentResultFinalizationError) {
      this.logger.warn(fields, "Agent run result finalization failed");
    } else {
      this.logger.warn(fields, "Agent run failed");
    }
  }

  private projectRunError(error: unknown): SlideXRunPublicError {
    if (error instanceof SlideXAgentModelCredentialError) {
      return MODEL_CREDENTIAL_REJECTED;
    }
    if (error instanceof SlideXAgentModelQuotaError) {
      return MODEL_QUOTA_EXHAUSTED;
    }
    if (error instanceof SlideXDeckValidationError) {
      return DECK_VALIDATION_FAILED;
    }
    return error instanceof SlideXAgentResultFinalizationError
      ? FINALIZATION_FAILED
      : RUN_FAILED;
  }

  private handleRunSettled(lifecycle: SlideXRunLifecycleContext): void {
    this.resetAddresses.delete(lifecycle.addressKey);
  }

  private requireAcceptedSession(
    lifecycle: SlideXRunLifecycleContext
  ): Promise<Session> {
    if (!lifecycle.acceptedSession) {
      throw new SlideXAgentResultFinalizationError();
    }
    return lifecycle.acceptedSession;
  }

  private async persistTerminalFailure(input: {
    acceptedSession: Promise<Session>;
    addressKey: string;
    runId: string;
    cancelled: boolean;
    publicError?: SlideXRunPublicError;
  }): Promise<void> {
    if (this.resetAddresses.has(input.addressKey)) {
      return;
    }

    const session = await input.acceptedSession;
    session.messages.push(makeMessage({
      role: "assistant",
      content: input.cancelled
        ? "Run cancelled."
        : input.publicError?.message ?? RUN_FAILED.message,
      metadata: {
        outcome: input.cancelled ? "cancelled" : "error",
        runId: input.runId,
        ...(input.publicError ? { errorCode: input.publicError.code } : {})
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
