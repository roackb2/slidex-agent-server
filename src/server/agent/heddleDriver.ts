import fs from "node:fs/promises";
import path from "node:path";
import { createConversationEngine } from "@roackb2/heddle";
import type { ConversationEngine } from "@roackb2/heddle";
import type { Env } from "../env.js";
import {
  createHeddleChatRepositoryResolver,
  type HeddleChatRepositories
} from "./heddleChatStorage.js";
import { prepareSlideXExtension } from "./slidexExtension.js";
import { runSlideXAgent } from "./slidexHeddleAgent.js";
import type { AgentDriver, AgentRunArgs } from "./types.js";

/**
 * Heddle-backed agent driver.
 *
 * Boundary: this driver owns Heddle wiring. It prepares the self-contained
 * SlideX MCP host extension ONCE (shared across all requests), then builds a
 * fresh, user-scoped conversation engine per request — the user's selected
 * request-scoped model credential, a
 * per-user/session state root, and the shared extension — and delegates the turn
 * to the SlideX agent module. The stable state root lets each fresh engine reuse
 * the same durable Heddle conversation. Heddle owns the MCP subprocess lifecycle
 * via the extension, so the server's StdioMcpProcessManager is not used here.
 */
export function createHeddleDriver(env: Env): AgentDriver {
  const resolveRepositories = createHeddleChatRepositoryResolver(env);
  return {
    async run(args) {
      await args.emit({
        type: "status",
        message: "Preparing SlideX tools"
      });
      await args.emit({
        type: "status",
        message: "Creating user-scoped Heddle conversation engine"
      });
      const engine = await createSlideXConversationEngine(
        env,
        args,
        resolveRepositories(args.user.id)
      );

      return runSlideXAgent({
        engine,
        sessionId: args.sessionId,
        motionDoc: args.motionDoc,
        message: args.message,
        model: args.model,
        signal: args.signal,
        emit: args.emit
      });
    }
  };
}

export async function createSlideXConversationEngine(
  env: Env,
  args: Pick<AgentRunArgs, "user" | "sessionId" | "modelCredential" | "model">,
  repositories: HeddleChatRepositories = {}
): Promise<ConversationEngine> {
  const extension = await prepareSlideXExtension(env);
  const stateRoot = path.join(
    env.dataDir,
    "heddle",
    safePathSegment(args.user.id),
    safePathSegment(args.sessionId)
  );
  await fs.mkdir(stateRoot, { recursive: true });

  // Dev-only: resolve credentials from a Heddle OAuth store (e.g. a Codex
  // subscription) instead of the per-request credential. Production always
  // uses the user's selected request-scoped credential.
  const devAuthStore =
    env.NODE_ENV !== "production" && env.DEV_HEDDLE_AUTH_STORE
      ? path.resolve(env.DEV_HEDDLE_AUTH_STORE)
      : undefined;

  const engine = createConversationEngine({
    workspaceRoot: env.HEDDLE_WORKSPACE_ROOT || process.cwd(),
    stateRoot,
    ...(devAuthStore
      ? { credentialStorePath: devAuthStore }
      : args.modelCredential.type === "api-key"
        ? { apiKey: args.modelCredential.apiKey, preferApiKey: true }
        : { credential: args.modelCredential }),
    model: args.model,
    ...repositories,
    memoryMaintenanceMode: "none",
    toolProfile: {
      preset: "default",
      memoryMode: "none"
    },
    hostExtensions: [extension.extension]
  });

  if (devAuthStore) {
    console.warn(
      `[agent] DEV_HEDDLE_AUTH_STORE is ON — using Heddle OAuth credentials from ${devAuthStore} instead of the request-scoped model credential.`
    );
  }

  return engine;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
}
