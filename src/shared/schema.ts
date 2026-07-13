import { z } from "zod";
import {
  ConversationRunProtocolCodec,
  type ConversationRunProtocolEvent
} from "@roackb2/heddle-remote";

export const ChatRoleSchema = z.enum(["user", "assistant", "system", "tool"]);

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: ChatRoleSchema,
  content: z.string(),
  createdAt: z.string(),
  metadata: z.record(z.unknown()).optional()
});

export const SessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestMotionDoc: z.string().default(""),
  messages: z.array(ChatMessageSchema).default([])
});

export const SessionSummarySchema = SessionSchema.pick({
  id: true,
  userId: true,
  title: true,
  createdAt: true,
  updatedAt: true
}).extend({
  messageCount: z.number(),
  hasMotionDoc: z.boolean()
});

export const CreateSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  motionDoc: z.string().max(2_000_000).optional()
});

export const SessionIdInputSchema = z.object({
  sessionId: z.string().min(1)
});

export const RenameSessionInputSchema = SessionIdInputSchema.extend({
  title: z.string().trim().min(1).max(120)
});

export const AgentStreamInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(20_000),
  motionDoc: z.string().max(2_000_000).default(""),
  llmApiKey: z.string().trim().min(8).max(20_000),
  model: z.string().trim().min(1).max(120).optional()
});

export const StartAgentRunInputSchema = AgentStreamInputSchema.extend({
  sourceRevision: z.string().trim().min(1).max(128)
});

export const StartAgentRunResultSchema = z.object({
  accepted: z.literal(true),
  runId: z.string(),
  acceptedAt: z.string(),
  session: SessionSchema
});

export const ActiveAgentRunSchema = z.object({
  runId: z.string().min(1),
  acceptedAt: z.string().min(1)
});

export const AgentSessionStateSchema = z.object({
  session: SessionSchema,
  activeRun: ActiveAgentRunSchema.nullable()
});

export const ResetAgentSessionResultSchema = z.object({
  reset: z.literal(true)
});

export const AgentApiErrorCodeSchema = z.enum([
  "auth_required",
  "invalid_request",
  "session_not_found",
  "run_not_found",
  "active_run_conflict",
  "replay_unavailable",
  "internal_error"
]);

export const AgentApiErrorResponseSchema = z.object({
  error: z.object({
    code: AgentApiErrorCodeSchema,
    message: z.string().min(1)
  })
});

export const PublicConversationActivitySchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    tool: z.string().optional(),
    result: z.object({
      ok: z.boolean().optional()
    }).optional()
  })
  .transform((activity) => activity.type === "assistant.stream"
    ? { type: activity.type }
    : activity);

export const SlideXRunResultSchema = z.object({
  session: SessionSchema,
  motionDoc: z.string(),
  assistantMessage: z.string(),
  baseSourceRevision: z.string()
});

export const AgentRunProtocol = new ConversationRunProtocolCodec({
  activity: PublicConversationActivitySchema,
  result: SlideXRunResultSchema
});

export const AgentRunEventSchema = AgentRunProtocol.eventSchema;

export const AgentStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session"),
    session: SessionSchema
  }),
  z.object({
    type: z.literal("status"),
    message: z.string(),
    detail: z.record(z.unknown()).optional()
  }),
  z.object({
    type: z.literal("token"),
    text: z.string()
  }),
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    status: z.enum(["started", "completed", "failed"]),
    detail: z.record(z.unknown()).optional()
  }),
  z.object({
    type: z.literal("motionDoc"),
    motionDoc: z.string()
  }),
  z.object({
    type: z.literal("complete"),
    session: SessionSchema,
    motionDoc: z.string()
  }),
  z.object({
    type: z.literal("error"),
    message: z.string()
  })
]);

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type AgentStreamInput = z.infer<typeof AgentStreamInputSchema>;
export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;
export type StartAgentRunInput = z.infer<typeof StartAgentRunInputSchema>;
export type StartAgentRunResult = z.infer<typeof StartAgentRunResultSchema>;
export type AgentSessionState = z.infer<typeof AgentSessionStateSchema>;
export type AgentApiErrorCode = z.infer<typeof AgentApiErrorCodeSchema>;
export type AgentRunEvent = ConversationRunProtocolEvent<
  z.infer<typeof PublicConversationActivitySchema>,
  z.infer<typeof SlideXRunResultSchema>
>;
