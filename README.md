# SlideX Agent Server

Small Node.js 20+ service for the SlideX conversational agent prototype.

It includes:

- Express server with tRPC for regular APIs.
- Express SSE route at `POST /api/agent/stream`.
- Zod validation for API inputs and persisted sessions.
- Supabase Auth token verification.
- Local JSON session storage for Railway persistent volumes.
- Heddle adapter that creates a per-request engine with the user's own LLM key while reusing one durable Heddle conversation per SlideX session.
- MotionDoc MCP stdio subprocess manager.
- React chat panel served by the same Express app in production.

## Local Setup

The checked-in `.env.example` is a runnable, zero-credential mock profile. It
uses API port `3010`, enables the reconnectable agent routes, accepts local
browser origins, and turns on the development auth bypass. It never calls an
LLM or starts the MotionDoc MCP.

```bash
npm install
cp .env.example .env
npm test
npm run dev:server
```

In the SlideX editor repository, add:

```bash
NEXT_PUBLIC_SLIDEX_AGENT_ENABLED=true
NEXT_PUBLIC_SLIDEX_AGENT_SERVER_URL=http://localhost:3010
```

Then start the editor normally and use its Agent panel. To run this server
repository's bundled Vite demo too, use `npm run dev`; that demo requires the
`VITE_SUPABASE_*` values documented in `.env.example`.

The API server binds `PORT` and the bundled Vite proxy reads the same value.
If the selected API port is taken, change `PORT` in `.env`; the server exits
with a clear bind error rather than silently choosing a different API port.

## Anonymous BYOK product acceptance

Use this path when you want to test the same boundaries as the SlideX editor,
not the development auth bypass. The local workspace is deliberately kept in
the ignored `.local/` directory: Supabase containers/configuration, local
session data, and prerelease package tarballs must not be committed.

Prerequisites are Node.js 20+ and a Docker-compatible runtime such as Docker
Desktop or OrbStack. Initialize the official Supabase CLI project once:

```bash
mkdir -p .local/supabase
npx supabase --workdir .local/supabase init
```

In `.local/supabase/supabase/config.toml`, use a unique `project_id`, set the
editor URL, and enable anonymous identities:

```toml
project_id = "slidex-agent-local"

[auth]
site_url = "http://127.0.0.1:3181"
enable_anonymous_sign_ins = true
```

Start the stack and print its local connection values:

```bash
npx supabase --workdir .local/supabase start
npx supabase --workdir .local/supabase status -o env
```

Copy `API_URL` to `SUPABASE_URL` and `ANON_KEY` to `SUPABASE_ANON_KEY` in this
repository's `.env`. Use the same values as `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` in the SlideX editor's `.env.local`. A real
server profile looks like this (the model key intentionally does not):

```bash
NODE_ENV=development
PORT=3180
DATA_DIR=.local/data
CORS_ORIGIN=http://127.0.0.1:3181,http://localhost:3181
AGENT_DRIVER=heddle
SLIDEX_AGENT_ENABLED=true
DEFAULT_MODEL=gpt-5.4
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<ANON_KEY from supabase status>
HEDDLE_WORKSPACE_ROOT=/absolute/path/to/SlideX
MOTIONDOC_MCP_COMMAND=npm
MOTIONDOC_MCP_ARGS='["run","mcp"]'
MOTIONDOC_MCP_CWD=/absolute/path/to/SlideX
```

Start the server and editor in separate terminals:

```bash
# This repository
npm run dev:server

# SlideX editor repository
npm run dev -- --port 3181
```

Open `http://127.0.0.1:3181/workspace/pitch/`, open Agent settings, and paste a
valid OpenAI API key. The expected product behavior is:

1. The first prompt creates or edits a deck and streams activity into the chat.
2. A follow-up edits the same deck with the same conversation context.
3. Refreshing the page restores chat and deck state, but the API key is gone.
4. Supplying the key again lets a read-only question answer without changing
   the deck.
5. An invalid key produces a stable credential-rejected message without a raw
   provider error; **Forget key** removes the tab-local key.
6. **New conversation** clears chat continuity without deleting the current
   editor deck.

For a repeatable API-level proof, export `OPENAI_API_KEY` (or
`PERSONAL_OPENAI_API_KEY`) in the shell and run:

```bash
npm run try:anonymous-byok
npm run try:anonymous-byok -- --quality
```

The first command performs a two-turn mutation flow. `--quality` adds a new
slide, a whole-deck restyle, and a read-only query. Both commands sign in as a
new anonymous Supabase user, use the public REST/SSE client, hydrate the final
session, and scan `DATA_DIR` to prove that the exact model key was not stored.
They print IDs, counts, booleans, and short assistant previews—never the key or
the full MotionDoc. A successful mutation flow requires an OpenAI API key with
available Responses API quota. Provider rejection exits non-zero, but the
failure report still includes the persisted-key match count.

Stop the local stack without deleting its volumes when finished:

```bash
npx supabase --workdir .local/supabase stop
```

## Agent Modes

`AGENT_DRIVER=mock` is the default for local development. It exercises tRPC,
local sessions, the reconnectable Heddle run lifecycle, SSE, cancellation, and
MotionDoc updates without calling an LLM. Mock and real modes use the same
`SlideXAgentRunService`; only model/tool execution changes.

`npm test` includes a deterministic full-application regression that enables
the reconnectable API with the non-production auth bypass, then exercises
start, canonical SSE activity/result delivery, cursor-bounded replay, history
hydration, a second turn, overlap conflict, cancellation, and conversation
reset through real HTTP routes. The suite also asserts that every run/session
operation requires authentication and that production ignores the development
auth bypass. The same test, typecheck, and build run in
`.github/workflows/agent-regression.yml`. Keep product lifecycle assertions in
this composed test and use handler stubs only for isolated transport errors.

The reconnectable run API is also default-off so deploying this branch preserves the upstream server behavior. Set `SLIDEX_AGENT_ENABLED=true` to register `/api/agent/runs`, `/api/agent/runs/:runId/events`, and `/api/agent/runs/:runId/cancel`. The SlideX editor must be built with `NEXT_PUBLIC_SLIDEX_AGENT_ENABLED=true` at the same time. Leave both flags unset or `false` to keep the conversational agent hidden; the existing `/api/agent/stream` route is unaffected.

When that server flag is enabled in production, `CORS_ORIGIN` must be an
explicit comma-separated allowlist such as `https://editor.example.com`; `*`
and a missing value fail startup. Origins are normalized and matched exactly.
Requests without an `Origin` header remain available to same-origin/server
clients, while credential-bearing browser access uses an injected
`Authorization` header—not cookies. CORS only controls browser read access and
never replaces endpoint authentication.

### Testing without Supabase (dev auth bypass)

If you don't have Supabase set up, enable `DEV_AUTH_BYPASS=1` (dev only — it is ignored when `NODE_ENV=production`). Every request then authenticates as `DEV_USER_ID` (default `dev-user`), so you can drive the tRPC procedures, the web UI, and `/api/agent/stream` with no token. Example — the full agent stream over HTTP:

```bash
DEV_AUTH_BYPASS=1 AGENT_DRIVER=mock npm run dev:server
# in another shell (use the server port printed by `npm run dev:server`):
curl -sN -X POST http://localhost:3010/api/agent/stream \
  -H 'content-type: application/json' \
  -d '{"message":"Create a deck about stateless agents","motionDoc":"","llmApiKey":"dummy-key-123456"}'
```

With `AGENT_DRIVER=heddle` the same call runs the real agent (needs a valid `llmApiKey` in the body and `MOTIONDOC_MCP_*` configured).

For pre-publication dogfood, install exact locally packed Heddle tarballs with
`npm install --no-save --package-lock=false /path/to/package.tgz`. Keep the
committed manifests on registry versions; update them to the exact new release
only after the local integration proof passes. Set `AGENT_DRIVER=heddle` and
point at the SlideX MotionDoc MCP command:

```bash
AGENT_DRIVER=heddle
HEDDLE_WORKSPACE_ROOT=/app
MOTIONDOC_MCP_COMMAND=node
MOTIONDOC_MCP_ARGS='["/app/path/to/motiondoc-mcp.js"]'
MOTIONDOC_MCP_CWD=/app
```

The SlideX conversational agent is built in this repo (`src/server/agent/slidexHeddleAgent.ts`), driven by `src/server/agent/heddleDriver.ts`. The driver prepares the SlideX MCP once as a **self-contained Heddle host extension**, then builds a fresh, user-scoped conversation engine per request and delegates the turn to the agent module. The stable per-user/session `stateRoot` and deterministic internal session ID make those engines reuse one durable Heddle conversation. Heddle owns model-facing history, leases, and compaction; the server's `Session.messages` remains the user-facing chat projection and is not replayed into model prompts.

The extension uses Heddle 4.2 mirror result-artifact rules for MotionDoc-writing tools. Each updated MotionDoc is persisted and set as the current session artifact while its full `source` remains inline for the next stateless MCP edit. The agent reads a newly mirrored artifact after the turn; if no new artifact was produced, it preserves the request's authoritative MotionDoc so a read-only turn cannot restore stale deck state.

Heddle owns the MCP subprocess lifecycle via the extension (spawned per tool call), so `MOTIONDOC_MCP_*` is just the command Heddle runs — the built-in `StdioMcpProcessManager` is not used on the Heddle path.

The server never stores the user's LLM API key. It is accepted only in the
run-start request body, passed into
`createConversationEngine({ apiKey, preferApiKey: true, model })` for that live
run, and omitted from product sessions, run events/results, Heddle
traces/artifacts, and logs. A rejected key becomes the stable
`model_credential_rejected` run terminal without exposing the provider's raw
error. A valid key without usable quota becomes the distinct
`model_quota_exhausted` terminal with billing-or-key recovery guidance; it is
not presented as a malformed credential.

Successful chat terminals use a SlideX-owned result projection. Changed decks
must include a passing validation result for the exact final MotionDoc, and the
visible assistant message is source-free and capped at 240 characters. Raw
model-authored assistant streams are not exposed before this terminal boundary.

Heddle's `stateRoot` is created per user/session under `DATA_DIR/heddle`, so its local state also lands on the Railway volume.

## Observability

HTTP requests emit structured Pino completion logs and return a generated
`X-Request-ID`. Accepted and terminal agent lifecycle records use `runId` as
the durable support correlation key and include only session ID, model,
outcome, duration, and tool-call count. Request serializers omit headers and
bodies, and defense-in-depth redaction covers bearer credentials, cookies, and
`llmApiKey`. Prompts, MotionDoc source, user identity, and raw provider errors
must not be logged. Set `LOG_LEVEL` to `fatal`, `error`, `warn`, `info`,
`debug`, `trace`, or `silent`; production defaults to `info`.

## Process lifecycle

On `SIGTERM` or `SIGINT`, the server immediately stops accepting new HTTP
connections and lets active requests—including an agent event stream—finish
for up to `SHUTDOWN_GRACE_MS` (default 30 seconds). It then force-closes any
remaining HTTP connections, stops owned subprocess resources, flushes logs,
and exits. Repeated signals join the same shutdown instead of running cleanup
twice. A forced close does not cancel a model/provider operation outside the
process; durable conversation history remains available after restart, while
process-local live-run replay does not.

## Railway

Railway deploys from `railway.json` and `Dockerfile`.

Runtime variables:

```bash
NODE_ENV=production
AGENT_DRIVER=heddle
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
DEFAULT_MODEL=gpt-4.1
LOG_LEVEL=info
SHUTDOWN_GRACE_MS=30000
HEDDLE_WORKSPACE_ROOT=/app
MOTIONDOC_MCP_COMMAND=...
MOTIONDOC_MCP_ARGS=...
MOTIONDOC_MCP_CWD=...
```

Attach a Railway volume and mount it at `/data`, or set `DATA_DIR` to the mounted path. If Railway injects `RAILWAY_VOLUME_MOUNT_PATH`, the server will use that when `DATA_DIR` is not set.

`GET /healthz` is used as the deployment healthcheck.

## API Shape

tRPC procedures:

- `health`
- `sessions.list`
- `sessions.create`
- `sessions.get`
- `sessions.rename`
- `sessions.delete`

SSE:

```http
POST /api/agent/stream
Authorization: Bearer <supabase-access-token>
Content-Type: application/json
Accept: text/event-stream
```

Body:

```json
{
  "sessionId": "optional-session-id",
  "message": "Create a deck from this outline",
  "motionDoc": "# Current deck",
  "llmApiKey": "user-owned-key",
  "model": "gpt-4.1"
}
```

Events are emitted as normal SSE frames with `event:` and JSON `data:` fields: `session`, `status`, `tool`, `token`, `motionDoc`, `complete`, and `error`.

When `SLIDEX_AGENT_ENABLED=true`, the reconnectable run API used by the SlideX editor is:

- `POST /api/agent/runs` to accept a run and return its `runId`.
- `GET /api/agent/sessions/:sessionId` to restore durable product history and
  discover the active Heddle run for that authenticated conversation.
- `DELETE /api/agent/sessions/:sessionId` to cancel any active run and reset the
  product conversation without changing the editor's current deck.
- `GET /api/agent/runs/:runId/events`, using either `?after=<sequence>` or
  `Last-Event-ID`, to stream and replay canonical Heddle run events.
- `POST /api/agent/runs/:runId/cancel` to request cancellation.

Every SSE frame uses the canonical event `kind` as `event:`, its ordered
`sequence` as `id:`, and the validated Heddle remote envelope as JSON `data:`.
JSON failures use `{ "error": { "code", "message" } }` with stable 401, 400,
404, 409, and sanitized 500 behavior. Product history records cancelled and
failed terminals so a restored conversation never ends with an unexplained
orphan user message.
