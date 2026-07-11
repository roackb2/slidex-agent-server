# SlideX agent service boundary

This directory owns the SlideX-specific orchestration around the Heddle SDK.

- `heddleDriver.ts` constructs a user-scoped Heddle conversation engine.
- `slidexHeddleAgent.ts` owns SlideX prompts, MotionDoc artifact resolution, and
  the SlideX tool-approval policy.
- `slidexAgentRunService.ts` coordinates durable SlideX sessions around
  Heddle's `ConversationRunService`. Heddle remains responsible for execution,
  cancellation, ordered activity events, and replay; this service adds product
  authorization, chat persistence, and MotionDoc finalization.
- `types.ts` and `runtime.ts` retain the legacy request-bound streaming driver
  while clients migrate to the reconnectable run protocol.

HTTP and SSE serialization belong in `server/routes`. MotionDoc editing logic
belongs in the MCP extension. Generic run behavior must be added to Heddle, not
reimplemented here.
