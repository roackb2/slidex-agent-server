# Product session storage boundary

`SessionStore` owns the durable SlideX conversation projection used by the
Railway service: user-visible messages, presentation association, catalog
ordering, cursor pagination, and atomic JSON replacement.

For the current single-replica MVP, files live under
`DATA_DIR/sessions/<user>/<session>.json` on a mounted persistent volume.
Catalog responses are bounded and omit messages, MotionDoc source, user IDs,
credentials, Heddle paths, traces, and run events. Sessions created before the
presentation-aware catalog remain readable but stay out of the catalog until
the authenticated editor immutably associates them with a presentation.

This boundary does not own:

- model execution, Heddle conversation state, replay, or cancellation;
- HTTP authentication and error projection;
- canonical Presentation Project storage;
- Supabase schema, RLS, or Workspace authorization.

When SlideX exposes its production agent-session table, replace the persistence
implementation behind the same list/detail/create/delete semantics. Do not run
JSON and Postgres as competing production sources of truth, and do not report a
database write as durable until it commits.
