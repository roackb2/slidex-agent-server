import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().optional(),
  RAILWAY_VOLUME_MOUNT_PATH: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  CORS_ORIGIN: z.string().optional(),
  AGENT_DRIVER: z.enum(["mock", "heddle"]).optional(),
  DEFAULT_MODEL: z.string().min(1).default("gpt-4.1"),
  HEDDLE_WORKSPACE_ROOT: z.string().optional(),
  MOTIONDOC_MCP_COMMAND: z.string().optional(),
  MOTIONDOC_MCP_ARGS: z.string().optional(),
  MOTIONDOC_MCP_CWD: z.string().optional()
});

export type Env = z.infer<typeof EnvSchema> & {
  AGENT_DRIVER: "mock" | "heddle";
  dataDir: string;
};

export function loadEnv(): Env {
  const parsed = EnvSchema.parse(process.env);
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
