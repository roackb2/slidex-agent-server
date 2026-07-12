import type { Server } from "node:http";
import { createHttpTerminator } from "http-terminator";

export type ShutdownLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export type GracefulShutdownOptions = {
  server: Server;
  logger: ShutdownLogger;
  graceMs: number;
  stopResources(): Promise<void>;
  exit(code: 0 | 1): void;
};

/**
 * Coordinates one bounded shutdown for every process signal.
 *
 * HTTP drains before owned subprocesses stop so an in-flight agent request can
 * still use its MCP resources. The timeout applies only to HTTP drain; each
 * owned resource is responsible for bounding its own stop operation.
 */
export function createGracefulShutdown(options: GracefulShutdownOptions) {
  let activeShutdown: Promise<void> | undefined;
  const httpTerminator = createHttpTerminator({
    server: options.server,
    gracefulTerminationTimeout: options.graceMs
  });

  return (signal: ShutdownSignal): Promise<void> => {
    activeShutdown ??= performShutdown(options, signal, httpTerminator.terminate);
    return activeShutdown;
  };
}

async function performShutdown(
  options: GracefulShutdownOptions,
  signal: ShutdownSignal,
  terminateHttp: () => Promise<void>
): Promise<void> {
  const startedAt = Date.now();
  options.logger.info({
    event: "server.shutdown_started",
    signal,
    graceMs: options.graceMs
  }, "Graceful shutdown started");

  let exitCode: 0 | 1 = 0;

  try {
    await terminateHttp();
  } catch (error) {
    exitCode = 1;
    options.server.closeAllConnections();
    options.logger.error({
      event: "server.shutdown_http_failed",
      signal,
      errorType: errorType(error)
    }, "HTTP server shutdown failed");
  }

  try {
    await options.stopResources();
  } catch (error) {
    exitCode = 1;
    options.logger.error({
      event: "server.shutdown_resource_failed",
      signal,
      errorType: errorType(error)
    }, "Owned resource shutdown failed");
  }

  options.logger.info({
    event: "server.shutdown_completed",
    signal,
    exitCode,
    durationMs: Date.now() - startedAt
  }, "Graceful shutdown completed");
  options.exit(exitCode);
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
