# SlideX agent service boundary

This directory owns the SlideX-specific orchestration around the Heddle SDK.

- `heddleDriver.ts` constructs a user-scoped Heddle conversation engine.
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
partially scrubbed, and source-free copy is capped for the narrow agent panel.
Raw `assistant.stream` text is withheld from product activity events until this
terminal projection has run; status and tool activity remain visible.
The route layer maps the service's stable product errors to HTTP status codes
and sanitizes unknown failures. Structured lifecycle logs contain only stable
correlation, outcome, and safe product error-code facts; prompts, MotionDoc
source, credentials, user identity, and raw provider/runtime errors must never
be logged.
