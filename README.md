# SlideX Agent Server

Small Node.js 20+ service for the SlideX conversational agent prototype.

It includes:

- Express server with tRPC for regular APIs.
- Express SSE route at `POST /api/agent/stream`.
- Zod validation for API inputs and persisted sessions.
- Supabase Auth token verification.
- Local JSON session storage for Railway persistent volumes.
- Heddle adapter that creates a per-request conversation engine with the user's own LLM key.
- MotionDoc MCP stdio subprocess manager.
- React chat panel served by the same Express app in production.

## Local Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Set these values in `.env`:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

`npm run dev` auto-allocates free ports (starting from `PORT`/`WEB_PORT`, default 3000/5173) so it won't collide with other local servers, and prints the actual URLs — the Vite dev proxy is pointed at the chosen server port automatically. Set `PORT`/`WEB_PORT` to pin them.

## Agent Modes

`AGENT_DRIVER=mock` is the default for local development. It exercises Supabase, tRPC, local sessions, SSE, and MotionDoc updates without calling an LLM.

The Heddle SDK is installed as `@roackb2/heddle` (>= 4.1.0). Set `AGENT_DRIVER=heddle` and point at the SlideX MotionDoc MCP command:

```bash
AGENT_DRIVER=heddle
HEDDLE_WORKSPACE_ROOT=/app
MOTIONDOC_MCP_COMMAND=node
MOTIONDOC_MCP_ARGS='["/app/path/to/motiondoc-mcp.js"]'
MOTIONDOC_MCP_CWD=/app
```

The SlideX conversational agent is built in this repo (`src/server/agent/slidexHeddleAgent.ts`), driven by `src/server/agent/heddleDriver.ts`. The driver prepares the SlideX MCP once as a **self-contained Heddle host extension** (Heddle >= 4.1.0), then builds a fresh, user-scoped conversation engine per request and delegates the turn to the agent module. Heddle owns the MCP subprocess lifecycle via the extension (spawned per tool call), so `MOTIONDOC_MCP_*` is just the command Heddle runs — the built-in `StdioMcpProcessManager` is not used on the Heddle path.

The server never stores the user's LLM API key. It is accepted only in the stream request body and passed into `createConversationEngine({ apiKey, preferApiKey: true, model })` for that request.

Heddle's `stateRoot` is created per user/session under `DATA_DIR/heddle`, so its local state also lands on the Railway volume.

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
