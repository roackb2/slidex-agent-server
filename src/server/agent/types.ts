import type { AuthUser } from "../auth.js";
import type { ModelCredential } from "../../shared/schema.js";

export type AgentEmit = (event: AgentProgressEvent) => void | Promise<void>;

export type AgentProgressEvent =
  | { type: "status"; message: string; detail?: Record<string, unknown> }
  | { type: "token"; text: string }
  | {
      type: "tool";
      name: string;
      status: "started" | "completed" | "failed";
      detail?: Record<string, unknown>;
    }
  | { type: "motionDoc"; motionDoc: string };

export type AgentRunArgs = {
  user: AuthUser;
  sessionId: string;
  motionDoc: string;
  message: string;
  modelCredential: ModelCredential;
  model: string;
  signal: AbortSignal;
  emit: AgentEmit;
};

export type AgentRunResult = {
  motionDoc: string;
  assistantMessage: string;
  metadata?: Record<string, unknown>;
};

export type AgentDriver = {
  run(args: AgentRunArgs): Promise<AgentRunResult>;
};
