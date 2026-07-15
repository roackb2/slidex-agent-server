import {
  ChatSessionAlreadyExistsError,
  HeddleEventType
} from "@roackb2/heddle";
import type {
  ConversationActivity,
  ConversationEngineHost,
  ConversationTurnResultSummary,
  ConversationTurnToolResult,
  ToolApprovalPolicyContext
} from "@roackb2/heddle";
import { z } from "zod";
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
    readExisting(
      id: string
    ): Promise<{ id: string; model?: string } | undefined>;
    create(input: {
      id?: string;
      name?: string;
      model?: string;
    }): Promise<{ id: string; model?: string }>;
    updateSettings(
      id: string,
      input: { model?: string }
    ): Promise<{ id: string; model?: string }>;
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

type ConversationSession = {
  id: string;
  model?: string;
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
export const SLIDEX_ASSISTANT_MESSAGE_MAX_CHARS = 240;

const VALIDATE_MOTION_DOC_TOOL = "slidex_validate_motion_doc";
const MOTION_DOC_SOURCE_MARKERS = [
  /```|~~~/,
  /<\s*\/?\s*[A-Z][A-Za-z0-9.:-]*\b/,
  /(?:Final|Current)\s+MotionDoc\s+source/i
] as const;
const VALIDATION_PASSED_MARKER = /\b(?:validation\s+(?:passed|succeeded)|passed\s+validation|isValid\s*:\s*true)\b/i;
const VALIDATION_SUFFIX = " Validation passed.";

const ValidationToolInputSchema = z.object({
  source: z.string()
});

const ValidationToolOutputSchema = z.object({
  isError: z.literal(false),
  structuredContent: z.object({
    result: z.object({
      isValid: z.boolean()
    })
  })
});

export class SlideXDeckValidationError extends Error {
  constructor() {
    super("The final MotionDoc was not successfully validated");
    this.name = "SlideXDeckValidationError";
  }
}

export type SlideXTurnProjection = {
  motionDoc: string;
  assistantMessage: string;
};

export async function runSlideXAgent(args: RunSlideXAgentArgs): Promise<AgentRunResult> {
  const { engine, emit } = args;

  await emit({ type: "status", message: "Starting SlideX agent turn" });

  const session = await resolveConversationSession(
    engine,
    args.sessionId,
    args.model
  );
  const previousArtifactId = engine.artifacts.current(session.id)?.id;

  const host = createProgressHost(emit);

  const result = await engine.turns.submit({
    sessionId: session.id,
    prompt: buildPrompt(args),
    maxSteps: args.maxSteps ?? DEFAULT_MAX_STEPS,
    abortSignal: args.signal,
    host
  });

  const projection = projectSlideXTurnResult({
    engine,
    sessionId: session.id,
    previousArtifactId,
    initialMotionDoc: args.motionDoc,
    result
  });
  if (projection.motionDoc !== args.motionDoc) {
    await emit({ type: "motionDoc", motionDoc: projection.motionDoc });
  }

  await emit({
    type: "status",
    message: "SlideX agent turn complete",
    detail: { outcome: result.outcome }
  });

  return {
    motionDoc: projection.motionDoc,
    assistantMessage: projection.assistantMessage,
    metadata: {
      outcome: result.outcome,
      toolCalls: result.toolResults.length
    }
  };
}

/** Builds a host that translates Heddle activity into transport progress events. */
function createProgressHost(emit: AgentEmit): ConversationEngineHost {
  return {
    ...createSlideXApprovalHost(),
    events: {
      onActivity(activity: ConversationActivity) {
        void emitForActivity(activity, emit);
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
  emit: AgentEmit
): Promise<void> {
  switch (activity.type) {
    case HeddleEventType.assistantStream:
      // Model text is not a product-safe summary until the terminal result has
      // passed SlideX's source-exclusion and length contract below.
      return;
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

/**
 * Finalizes the SlideX-specific product result for both agent transports.
 *
 * A changed deck must have a successful validation tool result for the exact
 * MotionDoc being returned. Model-authored summary text is never partially
 * scrubbed: source-like output is replaced with stable product copy, while
 * source-free output is bounded for the narrow chat panel.
 */
export function projectSlideXTurnResult(input: {
  engine: ConversationEngineLike;
  sessionId: string;
  previousArtifactId?: string;
  initialMotionDoc: string;
  result: ConversationTurnResultSummary;
}): SlideXTurnProjection {
  if (input.result.failure || input.result.outcome === "error") {
    throw new Error("SlideX agent turn did not complete successfully");
  }

  const motionDoc = resolveMotionDoc(
    input.engine,
    input.sessionId,
    input.previousArtifactId,
    input.initialMotionDoc
  );
  const motionDocChanged = motionDoc !== input.initialMotionDoc;
  if (motionDocChanged && resolveFinalValidation(input.result.toolResults, motionDoc) !== true) {
    throw new SlideXDeckValidationError();
  }

  return {
    motionDoc,
    assistantMessage: projectAssistantMessage({
      summary: input.result.summary,
      motionDocChanged
    })
  };
}

function resolveFinalValidation(
  toolResults: ConversationTurnToolResult[],
  motionDoc: string
): boolean | undefined {
  return toolResults.reduceRight<boolean | undefined>((resolved, toolResult) => {
    if (resolved !== undefined || toolResult.call.tool !== VALIDATE_MOTION_DOC_TOOL) {
      return resolved;
    }

    const callInput = ValidationToolInputSchema.safeParse(toolResult.call.input);
    if (!callInput.success || callInput.data.source !== motionDoc) {
      return undefined;
    }
    if (!toolResult.result.ok) {
      return false;
    }

    const output = ValidationToolOutputSchema.safeParse(toolResult.result.output);
    return output.success ? output.data.structuredContent.result.isValid : false;
  }, undefined);
}

function projectAssistantMessage(input: {
  summary: string;
  motionDocChanged: boolean;
}): string {
  const normalized = input.summary.replace(/\s+/g, " ").trim();
  const sourceFreeSummary = normalized
    && !MOTION_DOC_SOURCE_MARKERS.some((marker) => marker.test(normalized))
    ? normalized
    : input.motionDocChanged
      ? "Updated the deck."
      : "Answered the request without changing the deck.";
  const needsValidationSuffix = input.motionDocChanged
    && !VALIDATION_PASSED_MARKER.test(sourceFreeSummary);
  const contentLimit = needsValidationSuffix
    ? SLIDEX_ASSISTANT_MESSAGE_MAX_CHARS - VALIDATION_SUFFIX.length
    : SLIDEX_ASSISTANT_MESSAGE_MAX_CHARS;
  const conciseSummary = truncateAtWord(sourceFreeSummary, contentLimit);
  return needsValidationSuffix
    ? `${conciseSummary}${VALIDATION_SUFFIX}`
    : conciseSummary;
}

function truncateAtWord(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const candidate = value.slice(0, maxChars - 1).trimEnd();
  const wordBoundary = candidate.lastIndexOf(" ");
  const truncated = wordBoundary > maxChars / 2
    ? candidate.slice(0, wordBoundary)
    : candidate;
  return `${truncated.trimEnd()}…`;
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

Use the SlideX MotionDoc tools to fulfill the request and validate the final result. Reply with one short plain-text summary of what changed and whether validation passed. Never include MotionDoc source, fenced code, or SlideX component markup in the reply.`;
}

export async function resolveConversationSession(
  engine: ConversationEngineLike,
  slideXSessionId: string,
  model: string
): Promise<{ id: string }> {
  const sessionId = `slidex-${slideXSessionId}`;
  const existing = await engine.sessions.readExisting(sessionId);
  const session = existing ?? (
    await createConversationSession(
      engine,
      sessionId,
      slideXSessionId,
      model
    )
  );

  return session.model === model
    ? session
    : engine.sessions.updateSettings(session.id, { model });
}

async function createConversationSession(
  engine: ConversationEngineLike,
  sessionId: string,
  slideXSessionId: string,
  model: string
): Promise<ConversationSession> {
  try {
    return await engine.sessions.create({
      id: sessionId,
      name: `SlideX session ${slideXSessionId}`,
      model
    });
  } catch (error) {
    if (!(error instanceof ChatSessionAlreadyExistsError)) {
      throw error;
    }

    const concurrentSession = await engine.sessions.readExisting(sessionId);
    if (!concurrentSession) {
      throw error;
    }
    return concurrentSession;
  }
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
