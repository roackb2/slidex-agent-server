import { isDeepStrictEqual } from "node:util";
import type {
  ConversationEngine,
  ModelRunFailureCode,
  SubmitConversationTurnResult
} from "@roackb2/heddle";
import { Mutex } from "async-mutex";
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
import {
  AgentSessionPresentationConflictError,
  type AppendAgentSessionMessageInput,
  type AgentSessionRepository
} from "../storage/agentSessionRepository.js";
import {
  PresentationDocumentConflictError,
  type PresentationDocumentRepository
} from "../storage/presentationDocumentRepository.js";
import { createHeddleChatRepositoryResolver } from "./heddleChatStorage.js";
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

type PresentationBindingLock = {
  consumers: number;
  mutex: Mutex;
};

type SlideXRunResult = {
  session: Session;
  motionDoc: string;
  assistantMessage: string;
  baseSourceRevision: string;
  presentationSourceRevision?: number;
};

type DeckFinalization =
  | { status: "saved" | "unchanged"; sourceRevision: number }
  | { status: "pending" };

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
  presentationId: string;
  presentationSourceRevision: number;
  session: Session;
  sourceRevision: string;
  startedAt: number;
};

class SlideXAgentSessionResetError extends Error {}
class SlideXAgentPresentationConflictError extends Error {}
class SlideXAgentResultFinalizationError extends Error {}
class SlideXAgentCompletionRecordError extends Error {}
class SlideXAgentModelCredentialError extends Error {}
class SlideXAgentModelQuotaError extends Error {}

type CreateEngine = (
  env: Env,
  input: {
    user: AuthUser;
    sessionId: string;
    modelCredential: StartAgentRunInput["modelCredential"];
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
  message: "OpenAI rejected this model credential. Reconnect the Codex account or check the API key, then try again."
} as const;

const MODEL_QUOTA_EXHAUSTED = {
  code: "model_quota_exhausted",
  message: "This OpenAI credential is valid, but it has no available quota. Check the account plan or billing, then try again."
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

const COMPLETION_RECORD_FAILED = {
  code: "completion_record_failed",
  message: "The presentation is current, but the conversation completion could not be recorded. Refresh before sending another request."
} as const;

const PRESENTATION_CONFLICT = {
  code: "presentation_conflict",
  message: "The presentation changed while the agent was working. Review the current deck and try again."
} as const;

type SlideXRunPublicError =
  | typeof MODEL_CREDENTIAL_REJECTED
  | typeof MODEL_QUOTA_EXHAUSTED
  | typeof DECK_VALIDATION_FAILED
  | typeof RUN_FAILED
  | typeof FINALIZATION_FAILED
  | typeof COMPLETION_RECORD_FAILED
  | typeof PRESENTATION_CONFLICT;

const MODEL_FAILURE_ERROR_BY_CODE = new Map<
  ModelRunFailureCode,
  new () => Error
>([
  ["authentication", SlideXAgentModelCredentialError],
  ["quota", SlideXAgentModelQuotaError]
]);

export type SlideXAgentRunServiceOptions = {
  env: Env;
  agentSessionRepository: AgentSessionRepository;
  presentationDocumentRepository?: PresentationDocumentRepository;
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
  private readonly presentationBindingLocks = new Map<
    string,
    PresentationBindingLock
  >();
  private readonly createEngine: CreateEngine;
  private readonly logger: AgentRunLogger;

  constructor(private readonly options: SlideXAgentRunServiceOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    if (options.createEngine) {
      this.createEngine = options.createEngine;
      return;
    }
    if (options.env.AGENT_DRIVER === "mock") {
      this.createEngine = createMockConversationEngine;
      return;
    }

    const resolveRepositories = createHeddleChatRepositoryResolver(options.env);
    this.createEngine = (env, input) => createSlideXConversationEngine(
      env,
      input,
      resolveRepositories(input.user.id)
    );
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
      modelCredential: input.modelCredential,
      model,
      motionDoc: input.motionDoc,
      message: input.message
    });
    const conversation = await resolveConversationSession(
      engine,
      session.id,
      model
    );
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
      presentationId: input.presentationId,
      presentationSourceRevision: input.presentationSourceRevision,
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
    return this.withPresentationBindingLock({ userId, sessionId }, async () => {
      try {
        const session = await this.options.agentSessionRepository.attachSessionToPresentation(
          userId,
          sessionId,
          input
        );
        if (!session) {
          throw new SlideXAgentRunServiceError("session_not_found", "Conversation not found");
        }
        return session;
      } catch (error) {
        if (error instanceof AgentSessionPresentationConflictError) {
          throw new SlideXAgentRunServiceError(
            "invalid_request",
            "Conversation belongs to a different presentation"
          );
        }
        throw error;
      }
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
      await this.options.agentSessionRepository.deleteSession(userId, sessionId);
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
    return this.options.agentSessionRepository.createSession({
      userId,
      title: titleFromMessage(input.message),
      motionDoc: input.motionDoc,
      presentationId: input.presentationId,
      presentationTitle: input.presentationTitle
    });
  }

  private async requireProductSession(userId: string, sessionId: string): Promise<Session> {
    const session = await this.options.agentSessionRepository.getSession(userId, sessionId);
    if (!session) {
      throw new SlideXAgentRunServiceError("session_not_found", "Conversation not found");
    }
    return session;
  }

  private async persistAcceptedMessage(
    session: Session,
    input: { message: string; motionDoc: string },
    runId: string
  ): Promise<Session> {
    const persisted = await this.options.agentSessionRepository.appendRunMessage({
      userId: session.userId,
      sessionId: session.id,
      runId,
      kind: "user_input",
      role: "user",
      content: input.message,
      latestMotionDoc: input.motionDoc
    });
    if (!persisted) {
      throw new SlideXAgentRunServiceError("session_not_found", "Conversation not found");
    }
    return persisted;
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

    let currentSession: Session;
    let motionDoc: string;
    let assistantMessage: string;
    let finalization: DeckFinalization;
    try {
      currentSession = await this.requireAcceptedSession(lifecycle);
      ({ motionDoc, assistantMessage } = projectSlideXTurnResult({
        engine: lifecycle.engine,
        sessionId: lifecycle.conversationId,
        previousArtifactId: lifecycle.previousArtifactId,
        initialMotionDoc: lifecycle.initialMotionDoc,
        result: turnResult
      }));
      finalization = await this.finalizeDeck(lifecycle, motionDoc);
    } catch (error) {
      if (error instanceof SlideXDeckValidationError
        || error instanceof SlideXAgentPresentationConflictError) {
        throw error;
      }
      throw new SlideXAgentResultFinalizationError();
    }

    const persistedSession = await this.persistSuccessfulTerminal(
      {
        userId: currentSession.userId,
        sessionId: currentSession.id,
        runId: runContext.runId,
        kind: "assistant_terminal",
        role: "assistant",
        content: assistantMessage,
        metadata: {
          outcome: turnResult.outcome,
          toolCalls: turnResult.toolResults.length,
          deckFinalization: finalization.status,
          ...(finalization.status === "pending"
            ? {}
            : { presentationSourceRevision: finalization.sourceRevision })
        },
        latestMotionDoc: motionDoc
      },
      finalization
    );
    this.logger.info({
      event: "agent_run.terminal",
      runId: runContext.runId,
      sessionId: lifecycle.session.id,
      model: lifecycle.model,
      outcome: turnResult.outcome,
      durationMs: Date.now() - lifecycle.startedAt,
      toolCallCount: turnResult.toolResults.length,
      deckFinalization: finalization.status,
      ...(finalization.status === "pending"
        ? {}
        : { presentationSourceRevision: finalization.sourceRevision }),
      ...lifecycle.correlation
    }, "Agent run completed");
    return {
      session: persistedSession,
      motionDoc,
      assistantMessage,
      baseSourceRevision: lifecycle.sourceRevision,
      ...(finalization.status === "pending"
        ? {}
        : { presentationSourceRevision: finalization.sourceRevision })
    };
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
    } else if (error instanceof SlideXAgentCompletionRecordError) {
      this.logger.warn(fields, "Agent run completion record finalization failed");
    } else if (error instanceof SlideXAgentPresentationConflictError) {
      this.logger.warn(fields, "Agent run result conflicted with a newer presentation");
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
    if (error instanceof SlideXAgentPresentationConflictError) {
      return PRESENTATION_CONFLICT;
    }
    if (error instanceof SlideXAgentCompletionRecordError) {
      return COMPLETION_RECORD_FAILED;
    }
    return error instanceof SlideXAgentResultFinalizationError
      ? FINALIZATION_FAILED
      : RUN_FAILED;
  }

  private handleRunSettled(lifecycle: SlideXRunLifecycleContext): void {
    this.resetAddresses.delete(lifecycle.addressKey);
  }

  private async finalizeDeck(
    lifecycle: SlideXRunLifecycleContext,
    motionDoc: string
  ): Promise<DeckFinalization> {
    if (motionDoc === lifecycle.initialMotionDoc) {
      return {
        status: "unchanged",
        sourceRevision: lifecycle.presentationSourceRevision
      };
    }
    const repository = this.options.presentationDocumentRepository;
    if (!repository) {
      return { status: "pending" };
    }

    try {
      const saved = await repository.commitAgentResult({
        userId: lifecycle.session.userId,
        presentationId: lifecycle.presentationId,
        expectedSourceRevision: lifecycle.presentationSourceRevision,
        baseSource: lifecycle.initialMotionDoc,
        nextSource: motionDoc
      });
      return { status: "saved", sourceRevision: saved.sourceRevision };
    } catch (error) {
      if (error instanceof PresentationDocumentConflictError) {
        throw new SlideXAgentPresentationConflictError();
      }
      throw error;
    }
  }

  private async persistSuccessfulTerminal(
    input: AppendAgentSessionMessageInput,
    finalization: DeckFinalization
  ): Promise<Session> {
    try {
      const persisted = await this.options.agentSessionRepository.appendRunMessage(input);
      if (persisted) {
        return persisted;
      }
    } catch {
      const recovered = await this.recoverCommittedMessage(input);
      if (recovered) {
        return recovered;
      }
    }

    if (finalization.status === "pending") {
      throw new SlideXAgentResultFinalizationError();
    }
    throw new SlideXAgentCompletionRecordError();
  }

  private async recoverCommittedMessage(
    input: AppendAgentSessionMessageInput
  ): Promise<Session | null> {
    try {
      const session = await this.options.agentSessionRepository.getSession(
        input.userId,
        input.sessionId
      );
      if (!session) {
        return null;
      }
      const expectedMetadata = {
        ...(input.metadata ?? {}),
        runId: input.runId,
        kind: input.kind
      };
      const committed = session.messages.some((message) => (
        message.role === input.role
        && message.content === input.content
        && isDeepStrictEqual(message.metadata, expectedMetadata)
      ));
      return committed ? session : null;
    } catch {
      return null;
    }
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
    const persisted = await this.options.agentSessionRepository.appendRunMessage({
      userId: session.userId,
      sessionId: session.id,
      runId: input.runId,
      kind: "assistant_terminal",
      role: "assistant",
      content: input.cancelled
        ? "Run cancelled."
        : input.publicError?.message ?? RUN_FAILED.message,
      metadata: {
        outcome: input.cancelled ? "cancelled" : "error",
        ...(input.publicError ? { errorCode: input.publicError.code } : {})
      }
    });
    if (!persisted) {
      throw new SlideXAgentResultFinalizationError();
    }
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

  /**
   * Serializes the read-check-write binding transaction for one product
   * session. Reference counting prevents inactive session keys from
   * accumulating for the lifetime of the process.
   */
  private async withPresentationBindingLock<T>(
    address: SlideXRunAddress,
    action: () => Promise<T>
  ): Promise<T> {
    const key = addressKey(address);
    const lock = this.presentationBindingLocks.get(key) ?? {
      consumers: 0,
      mutex: new Mutex()
    };
    lock.consumers += 1;
    this.presentationBindingLocks.set(key, lock);

    try {
      return await lock.mutex.runExclusive(action);
    } finally {
      lock.consumers -= 1;
      if (lock.consumers === 0) {
        this.presentationBindingLocks.delete(key);
      }
    }
  }
}

function addressKey(address: SlideXRunAddress): string {
  return `${address.userId}:${address.sessionId}`;
}

function titleFromMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled deck";
}
