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
  presentationId: z.string().min(1).optional(),
  presentationTitle: z.string().min(1).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestMotionDoc: z.string().default(""),
  messages: z.array(ChatMessageSchema).default([])
});

export const SessionSummarySchema = SessionSchema.pick({
  id: true,
  userId: true,
  title: true,
  presentationId: true,
  presentationTitle: true,
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

const OpenAiApiKeySchema = z.string().trim().min(8).max(20_000);

export const OpenAiRuntimeCredentialSchema = z.object({
  type: z.literal("oauth-access-token"),
  provider: z.literal("openai"),
  accessToken: z.string().trim().min(1).max(20_000),
  expiresAt: z.number().int().positive(),
  accountId: z.string().trim().min(1).max(512).optional()
});

export const ModelCredentialSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("api-key"),
    provider: z.literal("openai"),
    apiKey: OpenAiApiKeySchema
  }),
  OpenAiRuntimeCredentialSchema
]);

const AgentStreamInputFields = {
  sessionId: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(20_000),
  motionDoc: z.string().max(2_000_000).default(""),
  modelCredential: ModelCredentialSchema.optional(),
  llmApiKey: OpenAiApiKeySchema.optional(),
  model: z.string().trim().min(1).max(120).optional()
} as const;

const AgentStreamInputObjectSchema = z.object(AgentStreamInputFields)
  .superRefine(requireExactlyOneModelCredential);

export const AgentStreamInputSchema = AgentStreamInputObjectSchema
  .transform(normalizeModelCredential);

export const AgentPresentationInputSchema = z.object({
  presentationId: z.string().trim().min(1).max(160),
  presentationTitle: z.string().trim().min(1).max(120)
});

export const StartAgentRunInputSchema = z.object({
  ...AgentStreamInputFields,
  ...AgentPresentationInputSchema.shape,
  sourceRevision: z.string().trim().min(1).max(128),
  presentationSourceRevision: z.number().int().nonnegative()
}).superRefine(requireExactlyOneModelCredential)
  .transform(normalizeModelCredential);

export const OpenAiDeviceCodeChallengeSchema = z.object({
  deviceAuthId: z.string().trim().min(1).max(2_048),
  userCode: z.string().trim().min(1).max(128),
  verificationUrl: z.string().url().refine(isOpenAiAuthUrl, {
    message: "OpenAI device verification must use auth.openai.com over HTTPS"
  }),
  intervalMs: z.number().int().positive(),
  expiresAt: z.number().int().positive()
});

export const OpenAiDeviceCodePollInputSchema = z.object({
  challenge: OpenAiDeviceCodeChallengeSchema
});

export const OpenAiDeviceCodePollResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("expired") }),
  z.object({
    status: z.literal("authorized"),
    credential: OpenAiRuntimeCredentialSchema
  })
]);

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

export const AgentSessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  presentation: z.object({
    id: z.string().min(1),
    title: z.string().min(1)
  }),
  createdAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative()
});

export const AgentSessionPageSchema = z.object({
  items: z.array(AgentSessionSummarySchema),
  nextCursor: z.string().min(1).optional()
});

export const ListAgentSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(1_024).optional()
});

export const AttachAgentSessionInputSchema = AgentPresentationInputSchema;

export const AttachAgentSessionResultSchema = z.object({
  session: SessionSchema
});

export const ResetAgentSessionResultSchema = z.object({
  reset: z.literal(true)
});

export const AgentApiErrorCodeSchema = z.enum([
  "auth_required",
  "invalid_request",
  "rate_limited",
  "model_auth_unavailable",
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
  baseSourceRevision: z.string(),
  presentationSourceRevision: z.number().int().nonnegative().optional()
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
export type StartAgentRunRequest = z.input<typeof StartAgentRunInputSchema>;
export type StartAgentRunResult = z.infer<typeof StartAgentRunResultSchema>;
export type AgentSessionState = z.infer<typeof AgentSessionStateSchema>;
export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>;
export type AgentSessionPage = z.infer<typeof AgentSessionPageSchema>;
export type ListAgentSessionsQuery = z.infer<typeof ListAgentSessionsQuerySchema>;
export type AttachAgentSessionInput = z.infer<typeof AttachAgentSessionInputSchema>;
export type AgentApiErrorCode = z.infer<typeof AgentApiErrorCodeSchema>;
export type AgentRunEvent = ConversationRunProtocolEvent<
  z.infer<typeof PublicConversationActivitySchema>,
  z.infer<typeof SlideXRunResultSchema>
>;
export type ModelCredential = z.infer<typeof ModelCredentialSchema>;
export type OpenAiDeviceCodeChallenge = z.infer<typeof OpenAiDeviceCodeChallengeSchema>;
export type OpenAiDeviceCodePollResult = z.infer<typeof OpenAiDeviceCodePollResultSchema>;

function requireExactlyOneModelCredential(
  input: {
    llmApiKey?: string;
    modelCredential?: z.infer<typeof ModelCredentialSchema>;
  },
  context: z.RefinementCtx
): void {
  if (Boolean(input.llmApiKey) === Boolean(input.modelCredential)) {
    context.addIssue({
      code: "custom",
      message: "Provide exactly one model credential",
      path: ["modelCredential"]
    });
  }
}

function normalizeModelCredential<
  T extends {
    llmApiKey?: string;
    modelCredential?: z.infer<typeof ModelCredentialSchema>;
  }
>(input: T) {
  const { llmApiKey, modelCredential, ...rest } = input;
  return {
    ...rest,
    modelCredential: modelCredential ?? {
      type: "api-key" as const,
      provider: "openai" as const,
      apiKey: llmApiKey!
    }
  };
}

function isOpenAiAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "auth.openai.com";
  } catch {
    return false;
  }
}
