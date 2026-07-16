import path from "node:path";
import {
  prepareMcpHostExtension,
  type McpHostResultArtifactRule,
  type PrepareMcpHostExtensionResult
} from "@roackb2/heddle";
import type { Env } from "../env.js";

/**
 * SlideX-specific Heddle host extension.
 *
 * SlideX's MotionDoc MCP is a stateless pure-function server (parse / validate /
 * create / edit / export all take `source` and return the new `source`). We wrap
 * it as a self-contained Heddle MCP host extension: `prepareMcpHostExtension`
 * (Heddle >= 4.1.0) embeds the resolved server config + catalog, so the SAME
 * prepared extension can be reused across cheap, per-request engines without any
 * per-engine MCP prep. Heddle spawns the MCP subprocess per tool call and closes
 * it (stateless), so no long-lived MCP process is managed here.
 *
 * This module owns the SlideX product specifics (which MCP, tool policy). It is
 * intentionally private to this repo — none of it belongs in the public Heddle
 * SDK.
 */

const SLIDEX_SERVER_ID = "slidex";
const EXTENSION_ID = "presentation-workspace";

// Keep this aligned with local MCP tools that return a changed MotionDoc at
// `structuredContent.result.source`. Read-only and export tools do not belong
// here; remote presentation tools use their own persisted/CAS boundary.
const MOTIONDOC_WRITER_TOOLS = [
  "slidex_create_deck",
  "slidex_create_from_template",
  "slidex_replace_slide",
  "slidex_update_slide_props",
  "slidex_add_block",
  "slidex_update_block",
  "slidex_delete_block",
  "slidex_duplicate_block",
  "slidex_reorder_block",
  "slidex_delete_slide",
  "slidex_reorder_slide",
  "slidex_apply_shader_preset",
  "slidex_create_slide_from_layout",
  "slidex_add_slide_from_layout",
  "slidex_replace_slide_with_layout"
] as const;

export const MOTIONDOC_RESULT_ARTIFACT_RULES: McpHostResultArtifactRule[] =
  MOTIONDOC_WRITER_TOOLS.map((toolName) => ({
    toolName,
    path: "structuredContent.result.source",
    mode: "mirror",
    kind: "source",
    domain: "slidex.motiondoc",
    extension: "mdx",
    setCurrent: true
  }));

export type PreparedSlideXExtension = Extract<PrepareMcpHostExtensionResult, { ok: true }>;

// Prepared once per process, keyed by the MCP invocation, so a server that
// handles many requests pays MCP setup (spawn + catalog refresh) a single time.
const preparedByKey = new Map<string, Promise<PrepareMcpHostExtensionResult>>();

export function resolveMcpServerConfig(env: Env): {
  command: string;
  args: string[];
  cwd: string;
} {
  if (!env.MOTIONDOC_MCP_COMMAND) {
    throw new Error(
      "MOTIONDOC_MCP_COMMAND is not configured. Set it to the SlideX MotionDoc MCP command (e.g. `npm`) with MOTIONDOC_MCP_ARGS and MOTIONDOC_MCP_CWD."
    );
  }
  return {
    command: env.MOTIONDOC_MCP_COMMAND,
    args: parseArgs(env.MOTIONDOC_MCP_ARGS),
    cwd: env.MOTIONDOC_MCP_CWD || process.cwd()
  };
}

export async function prepareSlideXExtension(env: Env): Promise<PreparedSlideXExtension> {
  const server = resolveMcpServerConfig(env);
  const key = JSON.stringify(server);

  let pending = preparedByKey.get(key);
  if (!pending) {
    // A shared, server-level state root only for the one-time catalog prep. The
    // prepared extension is self-contained, so per-request engines never read it.
    const prepareStateRoot = path.join(env.dataDir, "heddle", "_mcp-prepare");
    pending = prepareMcpHostExtension({
      id: EXTENSION_ID,
      workspaceRoot: server.cwd,
      stateRoot: prepareStateRoot,
      serverId: SLIDEX_SERVER_ID,
      server: {
        type: "stdio",
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        // SlideX MCP is a safe, local pure-function tool surface; no per-call
        // human approval. Host-side policy still gates non-slidex tools.
        tools: { approval: "never" }
      },
      defaultCapabilities: ["workspace.read"],
      hideDefaultMcpTools: true,
      // SlideX tools must keep the full MotionDoc inline for the next stateless
      // edit call. Mirror capture also persists each update so the host can read
      // the turn outcome through engine.artifacts.current(sessionId).
      resultArtifacts: MOTIONDOC_RESULT_ARTIFACT_RULES,
      systemContext: [
        "You are operating a SlideX presentation workspace through host-provided SlideX MotionDoc tools.",
        "SlideX tools are stateless: pass the current MotionDoc MDX `source` into each tool and use the `source` it returns as the new deck.",
        "Prefer SlideX tools for all deck creation, layout inspection, editing, validation, and HTML export. Do not edit files directly.",
        "Always validate the MotionDoc after edits, and keep the deck coherent with the user's request."
      ].join("\n")
    });
    preparedByKey.set(key, pending);
  }

  const prepared = await pending;
  if (!prepared.ok) {
    preparedByKey.delete(key); // allow a later retry after a transient MCP failure
    throw new Error(
      `Failed to prepare SlideX MCP host extension (${prepared.step}): ${prepared.error}`
    );
  }
  return prepared;
}

function parseArgs(raw?: string): string[] {
  if (!raw?.trim()) {
    return [];
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error("MOTIONDOC_MCP_ARGS JSON must be an array of strings");
    }
    return parsed as string[];
  }
  return trimmed.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}
