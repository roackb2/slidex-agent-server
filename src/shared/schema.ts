import { z } from "zod";

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

const ConversationActivitySchema = z
  .object({
    type: z.string()
  })
  .passthrough();

export const AgentRunEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("activity"),
    runId: z.string(),
    sequence: z.number().int().positive(),
    activity: ConversationActivitySchema
  }),
  z.object({
    type: z.literal("complete"),
    runId: z.string(),
    sequence: z.number().int().positive(),
    session: SessionSchema,
    motionDoc: z.string(),
    assistantMessage: z.string(),
    baseSourceRevision: z.string()
  }),
  z.object({
    type: z.literal("cancelled"),
    runId: z.string(),
    sequence: z.number().int().positive(),
    reason: z.string()
  }),
  z.object({
    type: z.literal("error"),
    runId: z.string(),
    sequence: z.number().int().positive(),
    message: z.string()
  })
]);

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
export type AgentRunEvent = z.infer<typeof AgentRunEventSchema>;
