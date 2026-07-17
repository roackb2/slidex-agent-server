import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PresentationDocumentConflictError,
  PresentationDocumentInaccessibleError
} from "./presentationDocumentRepository.js";
import {
  SupabasePresentationDocumentRepository,
  SupabasePresentationDocumentStorageError
} from "./supabasePresentationDocumentRepository.js";

const input = {
  userId: "00000000-0000-0000-0000-00000000000a",
  presentationId: "00000000-0000-0000-0000-00000000000b",
  expectedSourceRevision: 7,
  baseSource: "# Accepted base",
  nextSource: "# Agent result"
};

test("commits the agent result through the owner-scoped Presentation CAS", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const repository = new SupabasePresentationDocumentRepository({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return casResult("saved", 8);
    }
  } as unknown as SupabaseClient);

  assert.deepEqual(await repository.commitAgentResult(input), {
    sourceRevision: 8,
    updatedAt: "2026-07-17T00:00:00.000Z"
  });
  assert.deepEqual(calls, [{
    name: "mcp_compare_and_swap_presentation_document",
    args: {
      actor_user_id: input.userId,
      target_presentation_id: input.presentationId,
      expected_source_revision: 7,
      next_source: input.nextSource
    }
  }]);
});

test("retries one equivalent editor autosave without masking a real edit", async () => {
  const calls: Array<{ expectedRevision: number; nextSource: string }> = [];
  const filters: Array<[string, string]> = [];
  const client = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      calls.push({
        expectedRevision: args.expected_source_revision as number,
        nextSource: args.next_source as string
      });
      return calls.length === 1 ? casResult("conflict") : casResult("saved", 9);
    },
    from: () => ({
      select() {
        return this;
      },
      eq(column: string, value: string) {
        filters.push([column, value]);
        return this;
      },
      async maybeSingle() {
        return {
          data: { source: input.baseSource, source_revision: 8 },
          error: null
        };
      }
    })
  } as unknown as SupabaseClient;
  const repository = new SupabasePresentationDocumentRepository(client);

  assert.equal((await repository.commitAgentResult(input)).sourceRevision, 9);
  assert.deepEqual(calls, [
    { expectedRevision: 7, nextSource: input.nextSource },
    { expectedRevision: 8, nextSource: input.nextSource }
  ]);
  assert.deepEqual(filters, [
    ["id", input.presentationId],
    ["user_id", input.userId]
  ]);
});

test("rejects a conflict when the canonical source no longer matches the accepted base", async () => {
  let casCalls = 0;
  const client = {
    rpc: async () => {
      casCalls += 1;
      return casResult("conflict");
    },
    from: () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      async maybeSingle() {
        return {
          data: { source: "# Newer manual edit", source_revision: 8 },
          error: null
        };
      }
    })
  } as unknown as SupabaseClient;

  await assert.rejects(
    new SupabasePresentationDocumentRepository(client).commitAgentResult(input),
    PresentationDocumentConflictError
  );
  assert.equal(casCalls, 1);
});

test("distinguishes inaccessible documents from malformed storage responses", async () => {
  const inaccessible = new SupabasePresentationDocumentRepository({
    rpc: async () => casResult("inaccessible")
  } as unknown as SupabaseClient);
  await assert.rejects(
    inaccessible.commitAgentResult(input),
    PresentationDocumentInaccessibleError
  );

  const malformed = new SupabasePresentationDocumentRepository({
    rpc: async () => ({ data: [], error: null })
  } as unknown as SupabaseClient);
  await assert.rejects(
    malformed.commitAgentResult(input),
    SupabasePresentationDocumentStorageError
  );
});

function casResult(
  resultStatus: "saved" | "conflict" | "inaccessible",
  sourceRevision?: number
) {
  return {
    data: [{
      presentation_id: input.presentationId,
      result_status: resultStatus,
      source_revision: sourceRevision ?? null,
      title: resultStatus === "saved" ? "Deck" : null,
      updated_at: resultStatus === "saved"
        ? "2026-07-17T00:00:00.000000+00:00"
        : null
    }],
    error: null
  };
}
