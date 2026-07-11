import { HeddleEventType } from "@roackb2/heddle";
import type {
  ConversationActivity,
  ConversationEngineHost,
  ConversationTurnResultSummary,
  ToolApprovalPolicyContext
} from "@roackb2/heddle";
import type { AgentEmit, AgentRunResult } from "./types.js";

/**
 * The production SlideX conversational agent, built on Heddle.
 *
 * Responsibilities that are genuinely SlideX-specific live here (not in Heddle):
 * how to seed the authoritative current MotionDoc into a turn, resolve the
 * mirrored deck outcome, and translate Heddle's activity stream into the
 * server's transport-level progress events. The engine (with the self-contained
 * SlideX MCP host extension) is constructed by the driver and passed in.
 */

// Minimal structural view of the Heddle engine surface we use, so this module
// does not couple to Heddle's full engine type.
export type ConversationEngineLike = {
  sessions: {
    readExisting(id: string): { id: string; model?: string } | undefined;
    create(input: {
      id?: string;
      name?: string;
      model?: string;
    }): { id: string; model?: string };
    updateSettings(
      id: string,
      input: { model?: string }
    ): { id: string; model?: string };
  };
  turns: {
    submit(input: {
      sessionId: string;
      prompt: string;
      maxSteps?: number;
      abortSignal?: AbortSignal;
      host?: ConversationEngineHost;
    }): Promise<ConversationTurnResultSummary>;
  };
  artifacts: {
    current(sessionId: string): { id: string } | undefined;
    read(id: string): { content: string } | undefined;
  };
};

export type RunSlideXAgentArgs = {
  engine: ConversationEngineLike;
  sessionId: string;
  motionDoc: string;
  message: string;
  model: string;
  maxSteps?: number;
  signal: AbortSignal;
  emit: AgentEmit;
};

const DEFAULT_MAX_STEPS = 24;

export async function runSlideXAgent(args: RunSlideXAgentArgs): Promise<AgentRunResult> {
  const { engine, emit } = args;

  await emit({ type: "status", message: "Starting SlideX agent turn" });

  const session = resolveConversationSession(engine, args.sessionId, args.model);
  const previousArtifactId = engine.artifacts.current(session.id)?.id;

  const host = createProgressHost(emit);

  const result = await engine.turns.submit({
    sessionId: session.id,
    prompt: buildPrompt(args),
    maxSteps: args.maxSteps ?? DEFAULT_MAX_STEPS,
    abortSignal: args.signal,
    host
  });

  const motionDoc = resolveMotionDoc(engine, session.id, previousArtifactId, args.motionDoc);
  if (motionDoc !== args.motionDoc) {
    await emit({ type: "motionDoc", motionDoc });
  }

  await emit({
    type: "status",
    message: "SlideX agent turn complete",
    detail: { outcome: result.outcome }
  });

  return {
    motionDoc,
    assistantMessage: result.summary,
    metadata: {
      outcome: result.outcome,
      toolCalls: result.toolResults.length
    }
  };
}

/** Builds a host that translates Heddle activity into transport progress events. */
function createProgressHost(emit: AgentEmit): ConversationEngineHost {
  // assistant.stream text is cumulative per step; track per-step so we emit deltas.
  const streamedByStep = new Map<number, string>();

  return {
    ...createSlideXApprovalHost(),
    events: {
      onActivity(activity: ConversationActivity) {
        void emitForActivity(activity, emit, streamedByStep);
      }
    }
  };
}

export function createSlideXApprovalHost(): ConversationEngineHost {
  return {
    approvals: {
      // SlideX tools are pre-approved (safe, local, stateless); deny anything else.
      async requestToolApproval(request: ToolApprovalPolicyContext) {
        const tool = request.call.tool;
        return tool.startsWith("slidex_")
          ? { approved: true, reason: "SlideX MCP tool" }
          : { approved: false, reason: `Denied by SlideX host policy: ${tool}` };
      }
    }
  };
}

async function emitForActivity(
  activity: ConversationActivity,
  emit: AgentEmit,
  streamedByStep: Map<number, string>
): Promise<void> {
  switch (activity.type) {
    case HeddleEventType.assistantStream: {
      const prev = streamedByStep.get(activity.step) ?? "";
      const delta = activity.text.startsWith(prev)
        ? activity.text.slice(prev.length)
        : activity.text;
      streamedByStep.set(activity.step, activity.text);
      if (delta) {
        await emit({ type: "token", text: delta });
      }
      return;
    }
    case HeddleEventType.toolCalling:
      await emit({ type: "tool", name: activity.tool, status: "started" });
      return;
    case HeddleEventType.toolCompleted:
      await emit({
        type: "tool",
        name: activity.tool,
        status: activity.result.ok === false ? "failed" : "completed",
        detail: { durationMs: activity.durationMs }
      });
      return;
    case HeddleEventType.loopStarted:
      await emit({ type: "status", message: "Agent is working…" });
      return;
    case HeddleEventType.loopFinished:
      await emit({
        type: "status",
        message: "Agent finished",
        detail: { outcome: activity.outcome }
      });
      return;
    default:
      return;
  }
}

export function buildPrompt(args: Pick<RunSlideXAgentArgs, "motionDoc" | "message">): string {
  const trimmedDoc = args.motionDoc.trim();
  const motionDocContext = trimmedDoc
    ? `Current MotionDoc source (edit from this exact base and pass it into SlideX tools):
~~~mdx
${trimmedDoc}
~~~`
    : "There is no deck yet. Create a new MotionDoc for the request below.";

  return `${motionDocContext}

User request: ${args.message}

Use the SlideX MotionDoc tools to fulfill the request, validate the result, and reply with a short summary of what changed.`;
}

export function resolveConversationSession(
  engine: ConversationEngineLike,
  slideXSessionId: string,
  model: string
): { id: string } {
  const sessionId = `slidex-${slideXSessionId}`;
  const existing = engine.sessions.readExisting(sessionId);
  if (!existing) {
    return engine.sessions.create({
      id: sessionId,
      name: `SlideX session ${slideXSessionId}`,
      model
    });
  }

  return existing.model === model
    ? existing
    : engine.sessions.updateSettings(existing.id, { model });
}

export function resolveMotionDoc(
  engine: ConversationEngineLike,
  sessionId: string,
  previousArtifactId: string | undefined,
  fallback: string
): string {
  const currentArtifact = engine.artifacts.current(sessionId);
  if (!currentArtifact || currentArtifact.id === previousArtifactId) {
    return fallback;
  }

  const content = engine.artifacts.read(currentArtifact.id)?.content;
  if (!content?.trim()) {
    throw new Error(`Current MotionDoc artifact ${currentArtifact.id} could not be read`);
  }

  return content;
}
