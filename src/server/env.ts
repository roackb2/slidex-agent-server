import path from "node:path";
import { z } from "zod";
import { corsConfigurationIssue } from "./http/corsPolicy.js";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().optional(),
  RAILWAY_VOLUME_MOUNT_PATH: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  // Runtime/model memory and the product-visible transcript are separate
  // durability records, so deployments select each repository explicitly.
  HEDDLE_SESSION_STORAGE: z.enum(["file", "supabase"]).default("file"),
  SLIDEX_PRODUCT_SESSION_STORAGE: z.enum(["file", "supabase"]).default("file"),
  CORS_ORIGIN: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
  AGENT_DRIVER: z.enum(["mock", "heddle"]).optional(),
  SLIDEX_AGENT_ENABLED: z
    .enum(["false", "true"])
    .default("false")
    .transform((value) => value === "true"),
  DEFAULT_MODEL: z.string().min(1).default("gpt-4.1"),
  HEDDLE_WORKSPACE_ROOT: z.string().optional(),
  // Dev-only: skip Supabase auth and treat every request as a fixed local user.
  // Ignored in production (see AuthService). Handy when you don't have Supabase.
  DEV_AUTH_BYPASS: z.string().optional(),
  DEV_USER_ID: z.string().optional(),
  DEV_USER_EMAIL: z.string().optional(),
  // Dev-only: path to a Heddle auth.json with an OpenAI OAuth login (e.g. a
  // Codex subscription via `npx heddle auth login openai`). When set (and not
  // production), the Heddle driver ignores the per-request llmApiKey and lets
  // Heddle resolve the OAuth credential instead — so features can be tested
  // without API-key billing. Production always uses the per-request key.
  DEV_HEDDLE_AUTH_STORE: z.string().optional(),
  MOTIONDOC_MCP_COMMAND: z.string().optional(),
  MOTIONDOC_MCP_ARGS: z.string().optional(),
  MOTIONDOC_MCP_CWD: z.string().optional()
}).superRefine((env, context) => {
  const issue = corsConfigurationIssue(env.CORS_ORIGIN, {
    requireExplicitAllowlist:
      env.NODE_ENV === "production" && env.SLIDEX_AGENT_ENABLED
  });
  if (issue) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["CORS_ORIGIN"],
      message: issue
    });
  }
  if (
    env.HEDDLE_SESSION_STORAGE === "supabase"
    || env.SLIDEX_PRODUCT_SESSION_STORAGE === "supabase"
  ) {
    const selector = env.HEDDLE_SESSION_STORAGE === "supabase"
      ? "HEDDLE_SESSION_STORAGE"
      : "SLIDEX_PRODUCT_SESSION_STORAGE";
    if (!env.SUPABASE_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPABASE_URL"],
        message: `SUPABASE_URL is required when ${selector}=supabase`
      });
    }
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPABASE_SERVICE_ROLE_KEY"],
        message: `SUPABASE_SERVICE_ROLE_KEY is required when ${selector}=supabase`
      });
    }
  }
});

export type Env = z.infer<typeof EnvSchema> & {
  AGENT_DRIVER: "mock" | "heddle";
  dataDir: string;
};

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.parse(input);
  const dataDir =
    parsed.DATA_DIR ??
    parsed.RAILWAY_VOLUME_MOUNT_PATH ??
    path.resolve(process.cwd(), "data");

  return {
    ...parsed,
    AGENT_DRIVER:
      parsed.AGENT_DRIVER ?? (parsed.NODE_ENV === "production" ? "heddle" : "mock"),
    dataDir
  };
}

export function requireSupabaseConfig(env: Env): void {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.");
  }
}
