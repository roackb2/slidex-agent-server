import {
  ConversationRunService,
  type ConversationEngine,
  type ConversationRunHandle,
  type ConversationRunStreamItem,
  type ConversationTurnResultSummary
} from "@roackb2/heddle";
import type { AgentRunEvent, Session, StartAgentRunInput } from "../../shared/schema.js";
import type { AuthUser } from "../auth.js";
import type { Env } from "../env.js";
import { makeMessage, type SessionStore } from "../storage/sessionStore.js";
import { createSlideXConversationEngine } from "./heddleDriver.js";
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

type CreateEngine = (
  env: Env,
  input: {
    user: AuthUser;
    sessionId: string;
    llmApiKey: string;
    model: string;
  }
) => Promise<ConversationEngine>;

export type SlideXAgentRunServiceOptions = {
  env: Env;
  sessionStore: SessionStore;
  createEngine?: CreateEngine;
};

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
  private readonly createEngine: CreateEngine;

  constructor(private readonly options: SlideXAgentRunServiceOptions) {
    this.createEngine = options.createEngine ?? createSlideXConversationEngine;
  }

  async start(user: AuthUser, input: StartAgentRunInput) {
    const session = await this.resolveProductSession(user.id, input);
    const address = { userId: user.id, sessionId: session.id };
    const model = input.model || this.options.env.DEFAULT_MODEL;
    const engine = await this.createEngine(this.options.env, {
      user,
      sessionId: session.id,
      llmApiKey: input.llmApiKey,
      model
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

    const acceptedSession = this.persistAcceptedMessage(session, input);
    const result = run.result.then(async (turnResult) => {
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
            toolCalls: turnResult.toolResults.length
          }
        })
      );
      return {
        session: await this.options.sessionStore.writeSession(currentSession),
        motionDoc,
        assistantMessage: turnResult.summary,
        baseSourceRevision: input.sourceRevision
      };
    });
    result.catch(() => undefined);

    this.contexts.set(run.runId, { address, run, result });
    this.expireContext(run.runId, result);

    try {
      return {
        accepted: true as const,
        runId: run.runId,
        acceptedAt: run.acceptedAt,
        session: await acceptedSession
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
    const events = context.run.events({
      afterSequence: input.afterSequence,
      signal: input.signal
    });
    return this.mapRunEvents(context, events);
  }

  private async *mapRunEvents(
    context: SlideXRunContext,
    events: AsyncIterable<ConversationRunStreamItem<ConversationTurnResultSummary>>
  ): AsyncIterable<AgentRunEvent> {
    for await (const event of events) {
      if (event.kind === "activity") {
        yield {
          type: "activity",
          runId: event.runId,
          sequence: event.sequence,
          activity: event.activity
        };
        continue;
      }
      if (event.kind === "result") {
        try {
          const result = await context.result;
          yield {
            type: "complete",
            runId: event.runId,
            sequence: event.sequence,
            ...result
          };
        } catch (error) {
          yield {
            type: "error",
            runId: event.runId,
            sequence: event.sequence,
            message: error instanceof Error ? error.message : String(error)
          };
        }
        continue;
      }
      if (event.kind === "cancelled") {
        yield {
          type: "cancelled",
          runId: event.runId,
          sequence: event.sequence,
          reason: event.reason
        };
        continue;
      }
      yield {
        type: "error",
        runId: event.runId,
        sequence: event.sequence,
        message: event.error.message
      };
    }
  }

  cancel(userId: string, runId: string): boolean {
    return this.requireOwnedRun(userId, runId).run.cancel();
  }

  private async resolveProductSession(userId: string, input: StartAgentRunInput): Promise<Session> {
    if (input.sessionId) {
      return this.options.sessionStore.requireSession(userId, input.sessionId);
    }
    return this.options.sessionStore.createSession({
      userId,
      title: input.title ?? titleFromMessage(input.message),
      motionDoc: input.motionDoc
    });
  }

  private persistAcceptedMessage(session: Session, input: StartAgentRunInput): Promise<Session> {
    session.latestMotionDoc = input.motionDoc;
    session.messages.push(makeMessage({ role: "user", content: input.message }));
    return this.options.sessionStore.writeSession(session);
  }

  private requireOwnedRun(userId: string, runId: string): SlideXRunContext {
    const context = this.contexts.get(runId);
    if (!context || context.address.userId !== userId) {
      throw new Error(`Agent run not found: ${runId}`);
    }
    return context;
  }

  private expireContext(runId: string, result: Promise<SlideXRunResult>): void {
    void result.finally(() => {
      const timer = setTimeout(() => this.contexts.delete(runId), 5 * 60_000);
      timer.unref?.();
    }).catch(() => undefined);
  }
}

function titleFromMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled deck";
}
