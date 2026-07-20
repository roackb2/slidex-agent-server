import type { Request, Response } from "express";
import { rateLimit, type RateLimitRequestHandler } from "express-rate-limit";
import { ZodError } from "zod";
import {
  OpenAiDeviceCodeAuthService,
  type OpenAiDeviceCodeChallenge,
  type OpenAiDeviceCodePollResult
} from "@roackb2/heddle";
import {
  AgentApiErrorResponseSchema,
  OpenAiDeviceCodeChallengeSchema,
  OpenAiDeviceCodePollInputSchema,
  OpenAiDeviceCodePollResultSchema
} from "../../shared/schema.js";
import { AuthError, type AuthService } from "../auth.js";

export type OpenAiDeviceCodeAuthPort = {
  requestCode(): Promise<OpenAiDeviceCodeChallenge>;
  poll(challenge: OpenAiDeviceCodeChallenge): Promise<OpenAiDeviceCodePollResult>;
};

export type ModelAuthRouteDeps = {
  authService: AuthService;
  deviceCodeAuth?: OpenAiDeviceCodeAuthPort;
};

export function createRequestOpenAiDeviceCodeHandler(deps: ModelAuthRouteDeps) {
  const deviceCodeAuth = deps.deviceCodeAuth ?? OpenAiDeviceCodeAuthService;
  return async (request: Request, response: Response) => {
    setNoStore(response);
    try {
      await deps.authService.requireUserFromRequest(request);
      const challenge = await deviceCodeAuth.requestCode();
      response.json(OpenAiDeviceCodeChallengeSchema.parse(challenge));
    } catch (error) {
      sendModelAuthError(request, response, error);
    }
  };
}

export function createPollOpenAiDeviceCodeHandler(deps: ModelAuthRouteDeps) {
  const deviceCodeAuth = deps.deviceCodeAuth ?? OpenAiDeviceCodeAuthService;
  return async (request: Request, response: Response) => {
    setNoStore(response);
    try {
      await deps.authService.requireUserFromRequest(request);
      const { challenge } = OpenAiDeviceCodePollInputSchema.parse(request.body);
      const result = await deviceCodeAuth.poll(challenge);
      response.json(OpenAiDeviceCodePollResultSchema.parse(result));
    } catch (error) {
      sendModelAuthError(request, response, error);
    }
  };
}

export function createOpenAiDeviceCodeStartRateLimit(): RateLimitRequestHandler {
  return createModelAuthRateLimit({ limit: 10, windowMs: 10 * 60_000 });
}

export function createOpenAiDeviceCodePollRateLimit(): RateLimitRequestHandler {
  return createModelAuthRateLimit({ limit: 30, windowMs: 60_000 });
}

function createModelAuthRateLimit(input: {
  limit: number;
  windowMs: number;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: input.windowMs,
    limit: input.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, response) => {
      setNoStore(response);
      response.status(429).json(AgentApiErrorResponseSchema.parse({
        error: {
          code: "rate_limited",
          message: "Too many OpenAI sign-in requests. Wait before trying again."
        }
      }));
    }
  });
}

function setNoStore(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
}

function sendModelAuthError(
  request: Request,
  response: Response,
  error: unknown
): void {
  if (error instanceof AuthError) {
    response.status(401).json(AgentApiErrorResponseSchema.parse({
      error: { code: "auth_required", message: "Authentication required" }
    }));
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json(AgentApiErrorResponseSchema.parse({
      error: { code: "invalid_request", message: "The model-auth request was invalid" }
    }));
    return;
  }

  request.log?.warn({
    event: "model_auth.provider_failed",
    errorType: error instanceof Error ? error.name : typeof error
  }, "OpenAI device-code request failed");
  response.status(502).json(AgentApiErrorResponseSchema.parse({
    error: {
      code: "model_auth_unavailable",
      message: "OpenAI sign-in is temporarily unavailable. Try again."
    }
  }));
}
