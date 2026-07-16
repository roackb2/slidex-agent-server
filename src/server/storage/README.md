# Product conversation storage boundary

`AgentSessionRepository` owns SlideX's browser-safe conversation projection:
the presentation association, bounded catalog, user-visible transcript, and
idempotent accepted/terminal lifecycle writes. It deliberately does not own
Heddle's complete model-facing `ChatSession` record.

Two implementations share this contract:

- `SessionStore` is the default file adapter. It stores one atomic JSON record
  per user/session under `DATA_DIR/sessions` and remains useful for local or
  single-replica deployments with a persistent volume.
- `SupabaseAgentSessionRepository` is the shared production adapter. It uses
  `agent_sessions` for the catalog parent, `agent_session_messages` for the
  ordered safe transcript, `append_agent_session_message` for atomic ordinal
  allocation and catalog-count repair, and `presentations.source` as the
  canonical current deck.

The server resolves this boundary once from
`SLIDEX_PRODUCT_SESSION_STORAGE`. Selection is a clean cutover: there is no
dual-write, merge, or silent fallback between file and Supabase storage.

## Invariants

- Every operation is scoped to the verified product user. The Supabase adapter
  uses a service-role client, so every query and RPC call retains an explicit
  `user_id`; RLS bypass is never treated as authorization.
- A conversation is created with its canonical Presentation before a run can
  be accepted. Its Presentation association is immutable.
- The accepted user message commits before the run-start route returns `202`.
  Success, cancellation, and failure each append exactly one explainable
  assistant terminal.
- Message identity is `(session, user, run, lifecycle kind)`. An exact retry
  returns the existing message; a retry with changed content or metadata is a
  conflict rather than a second row.
- Catalog order is `updated_at DESC, id DESC`; the opaque cursor uses the same
  comparison so equal timestamps cannot skip or duplicate sessions.
- Catalog responses omit messages, MotionDoc source, user IDs, credentials,
  Heddle records, traces, artifacts, and run events.
- Hydration treats a mismatch between `agent_sessions.message_count` and the
  ordered message rows as storage corruption instead of silently hiding data.

## Adjacent ownership

This directory does not own:

- Heddle model execution, runtime conversation records, leases, compaction,
  traces, or artifacts;
- process-local active-run coordination, cancellation, SSE, or short replay;
- HTTP authentication, CORS, or public error projection; or
- writes to canonical `presentations.source`, which remain in SlideX's editor
  save/compare-and-swap path.

Heddle runtime persistence is selected independently with
`HEDDLE_SESSION_STORAGE`. Cross-replica completed-conversation continuity
requires both selectors to use Supabase: product storage restores what the
user sees, while Heddle storage restores what the model remembers. Losing an
in-flight process-local run is an accepted MVP behavior; completed turns remain
available after refresh or on another replica.
