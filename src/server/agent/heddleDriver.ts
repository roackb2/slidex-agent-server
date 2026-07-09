import fs from "node:fs/promises";
import path from "node:path";
import { createConversationEngine } from "@roackb2/heddle";
import type { Env } from "../env.js";
import { prepareSlideXExtension } from "./slidexExtension.js";
import { runSlideXAgent, type ConversationEngineLike } from "./slidexHeddleAgent.js";
import type { AgentDriver } from "./types.js";

/**
 * Heddle-backed agent driver.
 *
 * Boundary: this driver owns Heddle wiring. It prepares the self-contained
 * SlideX MCP host extension ONCE (shared across all requests), then builds a
 * fresh, user-scoped conversation engine per request — the user's API key, a
 * per-user/session state root, and the shared extension — and delegates the turn
 * to the SlideX agent module. Heddle owns the MCP subprocess lifecycle via the
 * extension, so the server's StdioMcpProcessManager is not used on this path.
 */
export function createHeddleDriver(env: Env): AgentDriver {
  return {
    async run(args) {
      await args.emit({
        type: "status",
        message: "Preparing SlideX tools"
      });
      const extension = await prepareSlideXExtension(env);

      await args.emit({
        type: "status",
        message: "Creating user-scoped Heddle conversation engine"
      });

      const stateRoot = path.join(
        env.dataDir,
        "heddle",
        safePathSegment(args.user.id),
        safePathSegment(args.sessionId)
      );
      await fs.mkdir(stateRoot, { recursive: true });

      const engine = createConversationEngine({
        workspaceRoot: env.HEDDLE_WORKSPACE_ROOT || process.cwd(),
        stateRoot,
        apiKey: args.llmApiKey,
        preferApiKey: true,
        model: args.model,
        memoryMaintenanceMode: "none",
        hostExtensions: [extension.extension]
      }) as unknown as ConversationEngineLike;

      return runSlideXAgent({
        engine,
        sessionId: args.sessionId,
        motionDoc: args.motionDoc,
        message: args.message,
        history: args.history,
        signal: args.signal,
        emit: args.emit
      });
    }
  };
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
}
