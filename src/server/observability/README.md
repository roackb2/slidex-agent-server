# Server observability boundary

This service owns production-safe structured logs for the SlideX agent server:

- one generated `X-Request-ID` for every HTTP request;
- compact request/response serializers that omit headers, cookies, and bodies;
- defense-in-depth Pino redaction for authorization, API-key, request-scoped
  access-token, and device-challenge fields;
- severity derived from the final HTTP status;
- stable agent lifecycle events correlated by public `runId` and product
  `sessionId` without logging prompts, MotionDoc source, credentials, or user
  identity.

It does not own metrics storage, tracing exporters, alert routing, billing, or
provider-specific diagnostics. Add those as injected deployment concerns; do
not put sensitive model/tool payloads back into the structured log schema.

`LOG_LEVEL` may override Pino's level. Tests default to `silent`; other
environments default to `info`.
