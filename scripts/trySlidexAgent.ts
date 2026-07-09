/**
 * Dev harness: run the SlideX Heddle agent end-to-end WITHOUT the HTTP/Supabase
 * stack. Exercises the real engine + SlideX MCP + LLM + MotionDoc extraction.
 *
 * Requires: OPENAI_API_KEY (or the key for DEFAULT_MODEL's provider),
 * MOTIONDOC_MCP_COMMAND/ARGS/CWD pointing at the SlideX MotionDoc MCP.
 *
 * Usage:
 *   OPENAI_API_KEY=... npx tsx scripts/trySlidexAgent.ts "Create a 5-slide pitch deck for SlideX."
 */
import "dotenv/config";
import { createHeddleDriver } from "../src/server/agent/heddleDriver.js";
import { StdioMcpProcessManager } from "../src/server/mcp/stdioMcp.js";
import { loadEnv } from "../src/server/env.js";
import type { AgentProgressEvent } from "../src/server/agent/types.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("Set OPENAI_API_KEY (or LLM_API_KEY) to run the agent harness.");
  }
  if (!env.MOTIONDOC_MCP_COMMAND) {
    throw new Error("Set MOTIONDOC_MCP_COMMAND/ARGS/CWD to the SlideX MotionDoc MCP.");
  }

  const message = process.argv.slice(2).join(" ").trim() || "Create a 5-slide pitch deck for SlideX.";
  const driver = createHeddleDriver(env);

  const emit = (event: AgentProgressEvent): void => {
    switch (event.type) {
      case "token":
        process.stdout.write(event.text);
        break;
      case "tool":
        process.stdout.write(`\n[tool] ${event.name} ${event.status}\n`);
        break;
      case "status":
        process.stdout.write(`\n[status] ${event.message}\n`);
        break;
      case "motionDoc":
        process.stdout.write(`\n[motionDoc updated: ${event.motionDoc.length} chars]\n`);
        break;
    }
  };

  console.log(`Model: ${env.DEFAULT_MODEL}`);
  console.log(`MCP: ${env.MOTIONDOC_MCP_COMMAND} ${env.MOTIONDOC_MCP_ARGS ?? ""}`);
  console.log(`Message: ${message}\n`);

  const result = await driver.run({
    user: { id: "dev-harness-user" },
    sessionId: "dev-harness-session",
    motionDoc: "",
    message,
    history: [],
    llmApiKey: apiKey,
    model: env.DEFAULT_MODEL,
    signal: new AbortController().signal,
    emit,
    mcpManager: new StdioMcpProcessManager(env)
  });

  console.log("\n\n=== RESULT ===");
  console.log("assistantMessage:", result.assistantMessage);
  console.log("motionDoc length:", result.motionDoc.length);
  console.log("metadata:", JSON.stringify(result.metadata));
  console.log("\n=== MotionDoc ===\n");
  console.log(result.motionDoc);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
