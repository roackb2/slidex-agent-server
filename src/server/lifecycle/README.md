# Server lifecycle boundary

This directory owns process-level HTTP drain and owned-resource shutdown.

On the first `SIGTERM` or `SIGINT`, `createGracefulShutdown` uses the focused
`http-terminator` connection tracker to:

1. stops the HTTP server from accepting new connections;
2. waits up to the configured grace period for active HTTP/SSE requests;
3. communicates connection closure to keep-alive clients and tracks active
   sockets without owning application request state;
4. force-closes remaining connections only after that deadline;
5. stops owned subprocess resources after requests can no longer use them;
6. records structured outcome facts and exits once.

The boundary does not cancel provider work outside this process, persist live
run replay, choose platform termination windows, or own model/tool lifecycle.
Each injected resource must bound its own `stopResources` work. Keep product
rate limits and deployment-specific orchestration outside this service.
