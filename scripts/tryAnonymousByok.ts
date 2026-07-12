/**
 * Product acceptance harness for the anonymous BYOK path.
 *
 * Unlike `trySlidexAgent.ts`, this goes through the same boundaries as the
 * SlideX editor: Supabase anonymous auth, REST run acceptance, reconnectable
 * SSE events, the Heddle driver, MotionDoc MCP tools, and durable hydration.
 * The model key is read from the process environment, sent only in each run
 * request, and checked against the server's local data directory afterward.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ConversationRunHttpSseClient } from "@roackb2/heddle-remote/http-sse";
import { z } from "zod";
import {
  AgentRunProtocol,
  AgentSessionStateSchema,
  StartAgentRunResultSchema,
  type AgentRunEvent,
  type StartAgentRunInput,
  type StartAgentRunResult
} from "../src/shared/schema.js";

const STARTER_MOTION_DOC = `<Slide duration={5} theme="light" background="#ffffff" accent="#2563eb" textColor="#0f172a">
  <Text x={10} y={28} width={80} fontSize={72} fontWeight={700}>A clear opening</Text>
  <Text x={10} y={52} width={70} fontSize={30}>Use conversation to turn this starter into a complete story.</Text>
</Slide>`;

const DEFAULT_TURNS = [
  "Turn this starter into a polished 5-slide deck introducing Heddle, a local-first coding agent harness.",
  "Make the opening slide more visual and concise while preserving the rest of the story."
] as const;

const QUALITY_TURNS = [
  "Add a comparison slide explaining how a local-first harness differs from a hosted chat assistant.",
  "Restyle the deck with a dark navy and cyan visual system while preserving its narrative.",
  "Without changing the deck, tell me how many slides it has and summarize the narrative in one sentence."
] as const;

type TurnResult = {
  events: AgentRunEvent[];
  terminal: Extract<AgentRunEvent, { kind: "result" }>;
};

async function main(): Promise<void> {
  const config = readConfig();
  const accessToken = await signInAnonymously(config.supabaseUrl, config.supabaseAnonKey);
  const authorization = `Bearer ${accessToken}`;
  const client = createRunClient(config.serverUrl, authorization);
  const turns = config.quality ? [...DEFAULT_TURNS, ...QUALITY_TURNS] : [...DEFAULT_TURNS];

  let motionDoc = STARTER_MOTION_DOC;
  let sessionId: string | undefined;
  const turnReports: Array<Record<string, unknown>> = [];

  try {
    for (const [index, message] of turns.entries()) {
      const before = motionDoc;
      const result = await runTurn(client, {
        sessionId,
        message,
        motionDoc,
        llmApiKey: config.llmApiKey,
        model: config.model,
        sourceRevision: sourceRevision(motionDoc)
      });
      motionDoc = result.terminal.result.motionDoc;
      sessionId = result.terminal.result.session.id;

      const readOnlyTurn = index === turns.length - 1 && config.quality;
      turnReports.push({
        turn: index + 1,
        runId: result.terminal.runId,
        eventCount: result.events.length,
        toolActivityCount: result.events.filter(isToolActivity).length,
        deckChanged: before !== motionDoc,
        expectedDeckChange: !readOnlyTurn,
        slideCount: countSlides(motionDoc),
        assistantPreview: preview(result.terminal.result.assistantMessage)
      });

      requireCondition(
        readOnlyTurn ? before === motionDoc : before !== motionDoc,
        readOnlyTurn
          ? `Turn ${index + 1} unexpectedly changed the deck`
          : `Turn ${index + 1} did not update the deck`
      );
    }
  } catch (error) {
    const leakedPaths = await findFilesContaining(config.dataDir, config.llmApiKey);
    console.error(JSON.stringify({
      accepted: false,
      completedTurns: turnReports.length,
      byokBoundary: { persistedKeyMatches: leakedPaths.length }
    }, null, 2));
    requireCondition(leakedPaths.length === 0, "The model key was found in server-owned local state");
    throw error;
  }

  requireCondition(sessionId !== undefined, "The server did not create a conversation");
  const hydrated = await getSessionState(config.serverUrl, authorization, sessionId);
  const leakedPaths = await findFilesContaining(config.dataDir, config.llmApiKey);
  const assistantMessages = hydrated.session.messages.filter(({ role }) => role === "assistant");
  const summaryLeaksSource = assistantMessages.some(({ content }) =>
    /```|~~~|<Slide\b|Final MotionDoc source/i.test(content)
  );

  requireCondition(hydrated.activeRun === null, "Hydrated session still reports an active run");
  requireCondition(
    hydrated.session.messages.length === turns.length * 2,
    `Expected ${turns.length * 2} persisted messages, got ${hydrated.session.messages.length}`
  );
  requireCondition(
    hydrated.session.latestMotionDoc === motionDoc,
    "Hydrated MotionDoc does not match the final run result"
  );
  requireCondition(leakedPaths.length === 0, "The model key was found in server-owned local state");
  requireCondition(countSlides(motionDoc) >= 5, "The final deck contains fewer than five slides");

  console.log(JSON.stringify({
    accepted: true,
    anonymousUserId: hydrated.session.userId,
    sessionId,
    turns: turnReports,
    persistence: {
      messageCount: hydrated.session.messages.length,
      activeRun: hydrated.activeRun,
      motionDocMatches: hydrated.session.latestMotionDoc === motionDoc
    },
    byokBoundary: {
      persistedKeyMatches: leakedPaths.length
    },
    qualitySignals: {
      summaryLeaksMotionDocSource: summaryLeaksSource,
      finalSlideCount: countSlides(motionDoc)
    }
  }, null, 2));

  if (summaryLeaksSource) {
    console.warn(
      "Quality warning: an assistant summary appears to include raw MotionDoc source. " +
      "The product flow passed, but this should be treated as a presentation-quality gap."
    );
  }
}

function readConfig(): {
  serverUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  llmApiKey: string;
  model: string;
  dataDir: string;
  quality: boolean;
} {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseAnonKey = requireEnv("SUPABASE_ANON_KEY");
  const llmApiKey = process.env.OPENAI_API_KEY ?? process.env.PERSONAL_OPENAI_API_KEY;
  if (!llmApiKey) {
    throw new Error("Set OPENAI_API_KEY or PERSONAL_OPENAI_API_KEY before running this acceptance check.");
  }

  return {
    serverUrl: (process.env.SLIDEX_AGENT_SERVER_URL ?? "http://127.0.0.1:3180").replace(/\/$/, ""),
    supabaseUrl,
    supabaseAnonKey,
    llmApiKey,
    model: process.env.DEFAULT_MODEL ?? "gpt-5.4",
    dataDir: path.resolve(process.env.DATA_DIR ?? ".local/data"),
    quality: process.argv.includes("--quality")
  };
}

async function signInAnonymously(supabaseUrl: string, supabaseAnonKey: string): Promise<string> {
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.session?.access_token) {
    throw new Error(`Anonymous Supabase sign-in failed: ${error?.message ?? "no access token returned"}`);
  }
  return data.session.access_token;
}

function createRunClient(serverUrl: string, authorization: string) {
  return new ConversationRunHttpSseClient<
    StartAgentRunInput,
    StartAgentRunResult,
    Extract<AgentRunEvent, { kind: "activity" }>["activity"],
    Extract<AgentRunEvent, { kind: "result" }>["result"],
    { cancelled: boolean }
  >({
    baseUrl: `${serverUrl}/api/agent`,
    protocol: AgentRunProtocol,
    accepted: StartAgentRunResultSchema,
    cancellation: z.object({ cancelled: z.boolean() }),
    getHeaders: () => ({ authorization })
  });
}

async function runTurn(
  client: ReturnType<typeof createRunClient>,
  input: StartAgentRunInput
): Promise<TurnResult> {
  const accepted = await client.start(input, AbortSignal.timeout(30_000));
  const events: AgentRunEvent[] = [];
  await client.subscribe({
    runId: accepted.runId,
    signal: AbortSignal.timeout(10 * 60_000),
    onEvent: (event) => {
      events.push(event);
      if (event.kind === "activity" && event.activity.text) {
        process.stdout.write(`\n[activity] ${event.activity.text}\n`);
      }
    }
  });

  const terminal = events.at(-1);
  if (!terminal) {
    throw new Error(`Run ${accepted.runId} ended without any events`);
  }
  if (terminal.kind === "error") {
    throw new Error(`Run ${accepted.runId} failed (${terminal.error.code}): ${terminal.error.message}`);
  }
  if (terminal.kind === "cancelled") {
    throw new Error(`Run ${accepted.runId} was cancelled: ${terminal.reason}`);
  }
  if (terminal.kind !== "result") {
    throw new Error(`Run ${accepted.runId} ended without a terminal result`);
  }
  return { events, terminal };
}

async function getSessionState(serverUrl: string, authorization: string, sessionId: string) {
  const response = await fetch(`${serverUrl}/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { authorization },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`Session hydration failed (${response.status})`);
  }
  return AgentSessionStateSchema.parse(await response.json());
}

async function findFilesContaining(root: string, secret: string): Promise<string[]> {
  const matches: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && (await fs.readFile(target)).includes(secret)) {
        matches.push(path.relative(root, target));
      }
    }
  };
  await visit(root);
  return matches;
}

function sourceRevision(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function countSlides(source: string): number {
  return source.match(/<Slide\b/g)?.length ?? 0;
}

function isToolActivity(event: AgentRunEvent): boolean {
  return event.kind === "activity" && event.activity.type.startsWith("tool.");
}

function preview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function requireEnv(name: "SUPABASE_URL" | "SUPABASE_ANON_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} before running this acceptance check.`);
  }
  return value;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
