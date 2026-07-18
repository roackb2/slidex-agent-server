# SlideX agent service boundary

This directory owns the SlideX-specific orchestration around the Heddle SDK.

- `heddleDriver.ts` constructs a user-scoped Heddle conversation engine.
- `supabaseChatSessionRepository.ts` implements Heddle's revisioned session
  repository contract against the server-only `agent_session_records` table.
  Each repository instance is scoped to one verified SlideX user, and every
  service-role query retains that explicit `user_id` predicate.
- `supabaseChatArchiveRepository.ts` implements Heddle's append-only compaction
  archive contract against `agent_session_archives`,
  `agent_session_archive_heads`, and `append_agent_session_archive`. Locators
  address stored content but never select authorization scope.
- `heddleChatStorage.ts` is the persistence composition root. File mode lets
  Heddle construct both local adapters; Supabase mode shares one server-only
  client and binds both repositories to the same verified user.
- `mockConversationEngine.ts` adapts the existing deterministic mock driver to
  the same engine/run-service path. Mock mode changes execution only; it must
  still exercise Heddle run identity, replay, cancellation, product history,
  and the production HTTP/SSE contracts.
- `slidexHeddleAgent.ts` owns SlideX prompts, MotionDoc artifact resolution,
  final-source validation, the concise/source-free assistant-message contract,
  and the SlideX tool-approval policy.
- `slidexAgentRunService.ts` coordinates durable SlideX sessions around
  `ConversationRunService` from `@roackb2/heddle/hosted`. Heddle remains
  responsible for execution, cancellation, ordered activity events, and replay;
  this service adds product authorization, chat persistence, MotionDoc
  finalization, session hydration/reset, active-run discovery, and the product
  result/error projection. Active-run lookup, retained-run authorization,
  terminal publication, replay expiry, and reset cancellation delegate to the
  existing Heddle run service; do not add a second run registry or terminal
  event mapper. Register Heddle lifecycle hooks together in `start`, but keep
  accepted, result, error, error-projection, and settled behavior in named
  service methods rather than inline callbacks.
- The product session association is immutable: a conversation may refresh its
  Presentation title but cannot be rebound to another Presentation ID.
  Presentation-aware catalog pagination remains in `server/storage`; the run
  service applies and validates the association when a run starts or a legacy
  session is attached. Legacy attachment is serialized per user/session so
  concurrent file-backed claims cannot bypass the read-check-write invariant.
  Supabase conversations are created with their immutable Presentation parent
  and do not depend on this process-local legacy lock.
- `types.ts` and `runtime.ts` retain the legacy request-bound streaming driver
  while clients migrate to the reconnectable run protocol.

The public run envelope and runtime payload validation come from
`@roackb2/heddle-remote`. The route composes Heddle's Node HTTP/SSE helper for
cursor parsing, framing, backpressure, and subscriber cleanup. Authentication,
authorization, API errors, CORS, and route policy remain in `server/routes`.
MotionDoc editing logic belongs in the MCP extension.
The shared schema projects Heddle's rich internal activities to the small
JSON-safe shape consumed by SlideX (`type`, `text`, `tool`, and `result.ok`);
internal engine state and traces must not cross the product API. Generic run
behavior must be added to Heddle, not reimplemented here.

Heddle v5 conversation lifecycle methods are asynchronous. This service always
awaits session lookup, creation, and settings updates before starting a turn.

`SLIDEX_PRODUCT_SESSION_STORAGE=file` is the default browser-visible product
history adapter. `SLIDEX_PRODUCT_SESSION_STORAGE=supabase` switches that
projection to `agent_sessions`, `agent_session_messages`, and
`append_agent_session_message`, while hydrating the current deck from
`presentations.source`. The accepted user message must commit before `202` is
returned; one idempotent terminal is then persisted for success, cancellation,
or failure. Every service-role operation remains scoped to the verified user.

`HEDDLE_SESSION_STORAGE=file` is the safe default: the stable per-user/session
`stateRoot` places the revisioned catalog and session bodies on the durable
`DATA_DIR` volume. The file adapter reads the v4 catalog/body layout and
upgrades a record on its next mutation, so deployments must keep the same
volume mounted during the package upgrade.

`HEDDLE_SESSION_STORAGE=supabase` injects both
`SupabaseChatSessionRepository` and `SupabaseChatArchiveRepository` into
`createConversationEngine`. This mode is an explicit cutover, not dual-write
or fallback behavior. Startup also requires `SUPABASE_URL` and the server-only
`SUPABASE_SERVICE_ROLE_KEY`. Keep file mode active until the session-record and
archive migrations, append RPC, grants, and live adapter acceptance have
passed in the target project. Product Presentation/session relationships and
visible chat projection remain in SlideX storage rather than in the Heddle
conversation record.

Use both Supabase selectors for cross-replica completed-conversation
continuity. Product storage restores the safe transcript; Heddle storage
restores model-facing memory plus completed compaction archives and their
rolling summary. Active execution, cancellation, SSE, and short replay remain
process-local, so an in-flight run may be lost with its process even though
previously committed input and completed turns survive.

Accepted user messages and success, cancellation, or failure terminals are
persisted as one explainable product history. Reset marks an in-flight address
before deleting its session so a late result cannot recreate deleted state.
The run-start request is the only SlideX boundary that accepts a user model
credential. The service passes it directly into the request-scoped engine and
retains only non-secret lifecycle fields. The key must never enter product
sessions, run results/events, Heddle traces or artifacts, logs, or error
messages. Heddle's safe `result.failure` category is the source of truth for
model failures; do not parse provider strings or add another HTTP-status
classifier here. Heddle `authentication` becomes `model_credential_rejected`;
Heddle `quota` becomes `model_quota_exhausted`. The latter remains a general
actionable run error so the editor does not refocus the key field as though a
valid but exhausted key were malformed.

Successful result projection is also a product boundary. A changed MotionDoc is
accepted only when the turn includes a successful `slidex_validate_motion_doc`
result for that exact final source. The same projected assistant message is
persisted and returned: source-like model output is replaced wholesale, never
partially scrubbed. Changed-deck summaries remain capped at 240 characters and
retain the authoritative validation outcome. Read-only answers preserve up to
1,200 characters so the product can honor a concise requested response format;
oversized copy stops after the last complete sentence that fits rather than
showing a sentence fragment.
Raw `assistant.stream` text is withheld from product activity events until this
terminal projection has run; status and tool activity remain visible.
In Supabase product mode, the run service then commits a changed source through
`PresentationDocumentRepository` before appending or publishing terminal
success. `presentationSourceRevision` is the database CAS revision;
`sourceRevision` remains the editor-source fingerprint used for local stale
result protection. An unchanged result skips the database write, a real CAS
conflict becomes `presentation_conflict`, and file product mode persists an
explicit `pending` deck-finalization status with the terminal and MotionDoc.
If the terminal append response is lost after commit, the service reads back
and accepts only the exact run terminal. A genuinely missing completion record
after a saved/unchanged deck becomes `completion_record_failed`, so the client
is told to refresh rather than retry an ambiguous mutation.
The route layer maps the service's stable product errors to HTTP status codes
and sanitizes unknown failures. Structured lifecycle logs contain only stable
correlation, outcome, and safe product error-code facts; prompts, MotionDoc
source, credentials, user identity, and raw provider/runtime errors must never
be logged.
