import type {
  ConversationActivity,
  ConversationEngineHost,
  ConversationTurnResultSummary,
  ToolApprovalPolicyContext
} from "@roackb2/heddle";
import type { ChatMessage } from "../../shared/schema.js";
import type { AgentEmit, AgentRunResult } from "./types.js";

/**
 * The production SlideX conversational agent, built on Heddle.
 *
 * Responsibilities that are genuinely SlideX-specific live here (not in Heddle):
 * how to seed the current MotionDoc into a turn, which tool results carry the
 * updated deck, and how to translate Heddle's activity stream into the server's
 * transport-level progress events. The engine (with the self-contained SlideX
 * MCP host extension) is constructed by the driver and passed in.
 */

// Minimal structural view of the Heddle engine surface we use, so this module
// does not couple to Heddle's full engine type.
export type ConversationEngineLike = {
  sessions: { create(input: { name?: string }): { id: string } };
  turns: {
    submit(input: {
      sessionId: string;
      prompt: string;
      maxSteps?: number;
      abortSignal?: AbortSignal;
      host?: ConversationEngineHost;
    }): Promise<ConversationTurnResultSummary>;
  };
  artifacts: { read(id: string): { content: string } | undefined };
};

export type RunSlideXAgentArgs = {
  engine: ConversationEngineLike;
  sessionId: string;
  motionDoc: string;
  message: string;
  history: ChatMessage[];
  maxSteps?: number;
  signal: AbortSignal;
  emit: AgentEmit;
};

// SlideX MCP tools whose result carries the full updated deck source. The last
// successful one in a turn is the new MotionDoc. (Read-only tools like
// slidex_get_template also return a `source`, so we don't treat those as edits.)
const MOTIONDOC_MUTATING_TOOLS = new Set([
  "slidex_create_deck",
  "slidex_create_from_template",
  "slidex_replace_slide",
  "slidex_update_slide_props",
  "slidex_add_block",
  "slidex_delete_slide",
  "slidex_reorder_slide",
  "slidex_create_slide_from_layout",
  "slidex_add_slide_from_layout",
  "slidex_replace_slide_with_layout"
]);

const DEFAULT_MAX_STEPS = 24;

export async function runSlideXAgent(args: RunSlideXAgentArgs): Promise<AgentRunResult> {
  const { engine, emit } = args;

  await emit({ type: "status", message: "Starting SlideX agent turn" });

  const session = engine.sessions.create({ name: `SlideX session ${args.sessionId}` });

  const host = createProgressHost(emit);

  const result = await engine.turns.submit({
    sessionId: session.id,
    prompt: buildPrompt(args),
    maxSteps: args.maxSteps ?? DEFAULT_MAX_STEPS,
    abortSignal: args.signal,
    host
  });

  const motionDoc = extractFinalMotionDoc(engine, result, args.motionDoc);
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
    events: {
      onActivity(activity: ConversationActivity) {
        void emitForActivity(activity, emit, streamedByStep);
      }
    },
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
    case "assistant.stream": {
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
    case "tool.calling":
      await emit({ type: "tool", name: activity.tool, status: "started" });
      return;
    case "tool.completed":
      await emit({
        type: "tool",
        name: activity.tool,
        status: activity.result.ok === false ? "failed" : "completed",
        detail: { durationMs: activity.durationMs }
      });
      return;
    case "loop.started":
      await emit({ type: "status", message: "Agent is working…" });
      return;
    case "loop.finished":
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

function buildPrompt(args: RunSlideXAgentArgs): string {
  const lines: string[] = [];

  if (args.history.length > 0) {
    lines.push("Conversation so far:");
    for (const message of args.history) {
      lines.push(`${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`);
    }
    lines.push("");
  }

  const trimmedDoc = args.motionDoc.trim();
  if (trimmedDoc) {
    lines.push("Current MotionDoc source (edit from this exact base and pass it into SlideX tools):");
    lines.push("```mdx");
    lines.push(trimmedDoc);
    lines.push("```");
    lines.push("");
  } else {
    lines.push("There is no deck yet. Create a new MotionDoc for the request below.");
    lines.push("");
  }

  lines.push(`User request: ${args.message}`);
  lines.push("");
  lines.push(
    "Use the SlideX MotionDoc tools to fulfill the request, validate the result, and reply with a short summary of what changed."
  );

  return lines.join("\n");
}

/**
 * The updated deck is the `source` returned by the last successful MotionDoc-
 * mutating tool call this turn. With result-artifact capture disabled, that
 * `source` is inline; we still resolve an artifact reference defensively.
 */
function extractFinalMotionDoc(
  engine: ConversationEngineLike,
  result: ConversationTurnResultSummary,
  fallback: string
): string {
  for (let i = result.toolResults.length - 1; i >= 0; i -= 1) {
    const entry = result.toolResults[i];
    if (!entry || entry.result.ok === false) {
      continue;
    }
    if (!MOTIONDOC_MUTATING_TOOLS.has(entry.call.tool)) {
      continue;
    }
    const source = readSource(engine, entry.result.output);
    if (source) {
      return source;
    }
  }
  return fallback;
}

function readSource(engine: ConversationEngineLike, output: unknown): string | undefined {
  const source = getPath(output, ["structuredContent", "result", "source"]);
  if (typeof source === "string" && source.trim()) {
    return source;
  }
  // Defensive: if a future config re-enables artifact capture, `source` becomes
  // a reference object; resolve it through the engine artifact reader.
  const artifactId = getPath(source, ["artifact", "id"]);
  if (typeof artifactId === "string") {
    const read = engine.artifacts.read(artifactId);
    if (read?.content) {
      return read.content;
    }
  }
  return undefined;
}

function getPath(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
