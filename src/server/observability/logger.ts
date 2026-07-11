import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import pino, { type DestinationStream, type Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { Env } from "../env.js";

const REDACTED = "[Redacted]";

export function createServerLogger(
  env: Env,
  destination?: DestinationStream
): Logger {
  return pino({
    level: env.LOG_LEVEL ?? (env.NODE_ENV === "test" ? "silent" : "info"),
    base: {
      pid: process.pid,
      hostname: hostname(),
      service: "slidex-agent-server",
      environment: env.NODE_ENV
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.llmApiKey",
        "request.headers.authorization",
        "request.headers.cookie",
        "request.body.llmApiKey",
        "llmApiKey",
        "*.llmApiKey"
      ],
      censor: REDACTED
    }
  }, destination);
}

export function createHttpLogger(logger: Logger) {
  return pinoHttp({
    logger,
    quietReqLogger: true,
    genReqId: (_request, response) => {
      const requestId = randomUUID();
      response.setHeader("X-Request-ID", requestId);
      return requestId;
    },
    customProps: () => ({ component: "http" }),
    customLogLevel: (_request, response, error) => {
      if (error || response.statusCode >= 500) {
        return "error";
      }
      if (response.statusCode >= 400) {
        return "warn";
      }
      return "info";
    },
    customSuccessMessage: () => "HTTP request completed",
    customErrorMessage: () => "HTTP request failed",
    serializers: {
      req: (request) => ({
        id: request.id,
        method: request.method,
        url: request.url,
        remoteAddress: request.remoteAddress
      }),
      res: (response) => ({ statusCode: response.statusCode })
    }
  });
}
