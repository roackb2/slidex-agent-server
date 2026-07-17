import type {
  ChatArchiveRepository,
  ChatSessionRepository
} from "@roackb2/heddle";
import { createClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import { SupabaseChatArchiveRepository } from "./supabaseChatArchiveRepository.js";
import { SupabaseChatSessionRepository } from "./supabaseChatSessionRepository.js";

export type HeddleChatRepositories = {
  sessionRepository?: ChatSessionRepository;
  archiveRepository?: ChatArchiveRepository;
};

export type HeddleChatRepositoryResolver = (
  userId: string
) => HeddleChatRepositories;

/**
 * Selects Heddle's complete persistence boundary once at service startup.
 * Supabase mode shares one server-only client and binds both repositories to
 * the same verified user. File mode lets Heddle construct both file adapters.
 */
export function createHeddleChatRepositoryResolver(
  env: Env
): HeddleChatRepositoryResolver {
  if (env.HEDDLE_SESSION_STORAGE === "file") {
    return () => ({});
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase Heddle storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
  return (userId) => ({
    sessionRepository: new SupabaseChatSessionRepository(client, userId),
    archiveRepository: new SupabaseChatArchiveRepository(client, userId)
  });
}
