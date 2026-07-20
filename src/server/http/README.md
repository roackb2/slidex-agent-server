# Inbound HTTP policy boundary

This directory owns browser-facing HTTP policy that must be applied uniformly
before product routes. It does not own identity, authorization, billing, model
credentials, product sessions, rate-limit values, or deployment networking.

The current CORS policy:

- preserves permissive local/upstream behavior when no production agent is
  enabled;
- requires an explicit non-wildcard allowlist when the reconnectable agent API
  is enabled in production;
- normalizes configured HTTP(S) origins and matches browser origins exactly;
- allows requests without `Origin` for same-origin and server clients;
- never enables cookie credentials and never treats CORS as authentication.

Add future inbound timeout or rate-limit policy here only after the host has
chosen its operational values. Heddle core must remain transport/deployment
agnostic.

The OpenAI device-code endpoints use narrow route-owned abuse limits in
`server/routes/modelAuth.ts`: ten challenge starts per ten minutes and thirty
polls per minute for one client address. The default in-memory limiter is
suitable for a single service process. A multi-replica deployment must enforce
the same or stricter shared limit at the edge or replace the limiter store;
replica-local counters are not a cross-replica security boundary.
