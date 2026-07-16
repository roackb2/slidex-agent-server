import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Env } from "../env.js";
import {
  PresentationDocumentConflictError,
  PresentationDocumentInaccessibleError,
  type CommitPresentationDocumentInput,
  type CommitPresentationDocumentResult,
  type PresentationDocumentRepository
} from "./presentationDocumentRepository.js";

const PRESENTATIONS_TABLE = "presentations";
const PRESENTATION_CAS_RPC = "mcp_compare_and_swap_presentation_document";
const TimestampSchema = z.string().datetime({ offset: true }).transform((value) => (
  new Date(value).toISOString()
));

const PresentationDocumentRowSchema = z.object({
  source: z.string(),
  source_revision: z.number().int().nonnegative()
});

const PresentationCasRowSchema = z.discriminatedUnion("result_status", [
  z.object({
    presentation_id: z.string().min(1),
    source_revision: z.number().int().nonnegative(),
    title: z.string(),
    updated_at: TimestampSchema,
    result_status: z.literal("saved")
  }),
  z.object({
    presentation_id: z.string().min(1),
    source_revision: z.null(),
    title: z.null(),
    updated_at: z.null(),
    result_status: z.enum(["conflict", "inaccessible"])
  })
]);

type SupabaseFailure = { code?: string; message?: string };

export class SupabasePresentationDocumentStorageError extends Error {
  constructor(operation: string) {
    super(`Supabase presentation storage failed during ${operation}`);
    this.name = "SupabasePresentationDocumentStorageError";
  }
}

/**
 * Service-role adapter for canonical Presentation finalization.
 *
 * The first CAS uses the revision accepted from the editor. A single retry is
 * allowed only when an intervening save wrote the exact accepted base source;
 * this absorbs the editor's normal autosave race without masking a real edit.
 */
export class SupabasePresentationDocumentRepository
  implements PresentationDocumentRepository {
  constructor(private readonly client: SupabaseClient) {}

  async commitAgentResult(
    input: CommitPresentationDocumentInput
  ): Promise<CommitPresentationDocumentResult> {
    const first = await this.compareAndSwap(input, input.expectedSourceRevision);
    if (first.status === "saved") {
      return first.result;
    }
    if (first.status === "inaccessible") {
      throw new PresentationDocumentInaccessibleError();
    }

    const current = await this.readCurrentDocument(input.userId, input.presentationId);
    if (current.source !== input.baseSource) {
      throw new PresentationDocumentConflictError();
    }

    const retry = await this.compareAndSwap(input, current.source_revision);
    if (retry.status === "saved") {
      return retry.result;
    }
    if (retry.status === "inaccessible") {
      throw new PresentationDocumentInaccessibleError();
    }
    throw new PresentationDocumentConflictError();
  }

  private async compareAndSwap(
    input: CommitPresentationDocumentInput,
    expectedSourceRevision: number
  ): Promise<
    | { status: "saved"; result: CommitPresentationDocumentResult }
    | { status: "conflict" | "inaccessible" }
  > {
    const { data, error } = await this.client.rpc(PRESENTATION_CAS_RPC, {
      actor_user_id: input.userId,
      target_presentation_id: input.presentationId,
      expected_source_revision: expectedSourceRevision,
      next_source: input.nextSource
    });
    if (error?.code === "40001") {
      return { status: "conflict" };
    }
    if (error?.code === "42501") {
      return { status: "inaccessible" };
    }
    throwIfSupabaseFailed("compare-and-swap presentation", error);

    const row = parseCasRow(data);
    if (row.result_status !== "saved") {
      return { status: row.result_status };
    }
    return {
      status: "saved",
      result: {
        sourceRevision: row.source_revision,
        updatedAt: row.updated_at
      }
    };
  }

  private async readCurrentDocument(
    userId: string,
    presentationId: string
  ) {
    const { data, error } = await this.client
      .from(PRESENTATIONS_TABLE)
      .select("source,source_revision")
      .eq("id", presentationId)
      .eq("user_id", userId)
      .maybeSingle();
    throwIfSupabaseFailed("read presentation after conflict", error);
    if (!data) {
      throw new PresentationDocumentInaccessibleError();
    }
    const result = PresentationDocumentRowSchema.safeParse(data);
    if (!result.success) {
      throw new SupabasePresentationDocumentStorageError(
        "validate presentation after conflict"
      );
    }
    return result.data;
  }
}

export function createPresentationDocumentRepository(
  env: Env
): PresentationDocumentRepository | undefined {
  if (env.SLIDEX_PRODUCT_SESSION_STORAGE !== "supabase") {
    return undefined;
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase presentation storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
  return new SupabasePresentationDocumentRepository(client);
}

function parseCasRow(value: unknown) {
  const result = z.array(PresentationCasRowSchema).length(1).safeParse(value ?? []);
  if (!result.success || !result.data[0]) {
    throw new SupabasePresentationDocumentStorageError(
      "validate compare-and-swap response"
    );
  }
  return result.data[0];
}

function throwIfSupabaseFailed(
  operation: string,
  error: SupabaseFailure | null
): void {
  if (error) {
    throw new SupabasePresentationDocumentStorageError(operation);
  }
}
