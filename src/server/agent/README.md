# SlideX agent service boundary

This directory owns the SlideX-specific orchestration around the Heddle SDK.

- `heddleDriver.ts` constructs a user-scoped Heddle conversation engine.
- `slidexHeddleAgent.ts` owns SlideX prompts, MotionDoc artifact resolution, and
  the SlideX tool-approval policy.
- `slidexAgentRunService.ts` coordinates durable SlideX sessions around
  `ConversationRunService` from `@roackb2/heddle/hosted`. Heddle remains
  responsible for execution, cancellation, ordered activity events, and replay;
  this service adds product authorization, chat persistence, MotionDoc
  finalization, and the product result projection.
- `types.ts` and `runtime.ts` retain the legacy request-bound streaming driver
  while clients migrate to the reconnectable run protocol.

The public run envelope and runtime payload validation come from
`@roackb2/heddle/remote`. HTTP/SSE handles, authentication, and route policy
remain in `server/routes`. MotionDoc editing logic belongs in the MCP extension.
The shared schema projects Heddle's rich internal activities to the small
JSON-safe shape consumed by SlideX (`type`, `text`, `tool`, and `result.ok`);
internal engine state and traces must not cross the product API. Generic run
behavior must be added to Heddle, not reimplemented here.
