import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import type {
  OpenAiDeviceCodeChallenge,
  OpenAiDeviceCodePollResult
} from "@roackb2/heddle";
import {
  OpenAiDeviceCodeChallengeSchema,
  OpenAiDeviceCodePollResultSchema,
  StartAgentRunInputSchema
} from "../../shared/schema.js";
import { AuthService } from "../auth.js";
import type { Env } from "../env.js";
import {
  createOpenAiDeviceCodeStartRateLimit,
  createPollOpenAiDeviceCodeHandler,
  createRequestOpenAiDeviceCodeHandler,
  type OpenAiDeviceCodeAuthPort
} from "./modelAuth.js";

const challenge: OpenAiDeviceCodeChallenge = {
  deviceAuthId: "device-auth-1",
  userCode: "ABCD-EFGH",
  verificationUrl: "https://auth.openai.com/codex/device",
  intervalMs: 5_000,
  expiresAt: Date.now() + 15 * 60_000
};

test("normalizes the legacy API-key field into the explicit model credential", () => {
  const parsed = StartAgentRunInputSchema.parse({
    presentationId: "presentation-1",
    presentationTitle: "Deck",
    presentationSourceRevision: 1,
    sourceRevision: "source-1",
    message: "Update the deck",
    motionDoc: "# Deck",
    llmApiKey: "legacy-api-key"
  });

  assert.deepEqual(parsed.modelCredential, {
    type: "api-key",
    provider: "openai",
    apiKey: "legacy-api-key"
  });
  assert.equal("llmApiKey" in parsed, false);
});

test("requires exactly one API-key or runtime model credential", () => {
  const base = {
    presentationId: "presentation-1",
    presentationTitle: "Deck",
    presentationSourceRevision: 1,
    sourceRevision: "source-1",
    message: "Update the deck",
    motionDoc: "# Deck"
  };
  const runtimeCredential = {
    type: "oauth-access-token" as const,
    provider: "openai" as const,
    accessToken: "runtime-access-token",
    expiresAt: Date.now() + 60_000
  };

  assert.deepEqual(
    StartAgentRunInputSchema.parse({ ...base, modelCredential: runtimeCredential })
      .modelCredential,
    runtimeCredential
  );
  assert.throws(() => StartAgentRunInputSchema.parse(base));
  assert.throws(() => StartAgentRunInputSchema.parse({
    ...base,
    llmApiKey: "legacy-api-key",
    modelCredential: runtimeCredential
  }));
});

test("rejects a device challenge that does not use the official OpenAI auth host", () => {
  assert.throws(() => OpenAiDeviceCodeChallengeSchema.parse({
    ...challenge,
    verificationUrl: "https://sign-in.example.test/codex/device"
  }));
});

test("returns an authenticated no-store OpenAI device-code challenge", async () => {
  let requestCount = 0;
  const deviceCodeAuth = createDeviceCodeAuth({
    requestCode: async () => {
      requestCount += 1;
      return challenge;
    }
  });
  const app = express();
  app.use(express.json());
  app.post("/device-code", createRequestOpenAiDeviceCodeHandler({
    authService: createAuthService(true),
    deviceCodeAuth
  }));

  await withHttpServer(app, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/device-code`, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.deepEqual(OpenAiDeviceCodeChallengeSchema.parse(await response.json()), challenge);
    assert.equal(requestCount, 1);
  });
});

test("keeps device-code polling stateless and returns only the runtime credential", async () => {
  const credential = {
    type: "oauth-access-token" as const,
    provider: "openai" as const,
    accessToken: "runtime-access-token",
    expiresAt: Date.now() + 60 * 60_000,
    accountId: "account-1"
  };
  const observed: OpenAiDeviceCodeChallenge[] = [];
  const deviceCodeAuth = createDeviceCodeAuth({
    poll: async (input) => {
      observed.push(input);
      return { status: "authorized", credential };
    }
  });
  const app = express();
  app.use(express.json());
  app.post("/poll", createPollOpenAiDeviceCodeHandler({
    authService: createAuthService(true),
    deviceCodeAuth
  }));

  await withHttpServer(app, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/poll`, { challenge });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(
      OpenAiDeviceCodePollResultSchema.parse(await response.json()),
      { status: "authorized", credential }
    );
    assert.deepEqual(observed, [challenge]);
  });
});

test("authenticates before contacting OpenAI and sanitizes provider failures", async () => {
  let requestCount = 0;
  const deviceCodeAuth = createDeviceCodeAuth({
    requestCode: async () => {
      requestCount += 1;
      throw new Error("provider-secret");
    }
  });

  const unauthenticated = express();
  unauthenticated.use(express.json());
  unauthenticated.post("/device-code", createRequestOpenAiDeviceCodeHandler({
    authService: createAuthService(false),
    deviceCodeAuth
  }));
  await withHttpServer(unauthenticated, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/device-code`, {});
    assert.equal(response.status, 401);
    assert.equal((await readError(response)).code, "auth_required");
    assert.equal(requestCount, 0);
  });

  const authenticated = express();
  authenticated.use(express.json());
  authenticated.post("/device-code", createRequestOpenAiDeviceCodeHandler({
    authService: createAuthService(true),
    deviceCodeAuth
  }));
  await withHttpServer(authenticated, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/device-code`, {});
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.match(body, /model_auth_unavailable/);
    assert.doesNotMatch(body, /provider-secret/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(requestCount, 1);
  });
});

test("rate limits repeated device-code starts without contacting the provider", async () => {
  let requestCount = 0;
  const app = express();
  app.use(express.json());
  app.post(
    "/device-code",
    createOpenAiDeviceCodeStartRateLimit(),
    createRequestOpenAiDeviceCodeHandler({
      authService: createAuthService(true),
      deviceCodeAuth: createDeviceCodeAuth({
        requestCode: async () => {
          requestCount += 1;
          return challenge;
        }
      })
    })
  );

  await withHttpServer(app, async (baseUrl) => {
    for (let index = 0; index < 10; index += 1) {
      assert.equal((await postJson(`${baseUrl}/device-code`, {})).status, 200);
    }
    const limited = await postJson(`${baseUrl}/device-code`, {});
    assert.equal(limited.status, 429);
    assert.equal((await readError(limited)).code, "rate_limited");
    assert.equal(limited.headers.get("cache-control"), "no-store");
    assert.equal(requestCount, 10);
  });
});

function createDeviceCodeAuth(overrides: Partial<OpenAiDeviceCodeAuthPort>): OpenAiDeviceCodeAuthPort {
  return {
    requestCode: overrides.requestCode ?? (async () => challenge),
    poll: overrides.poll ?? (async (): Promise<OpenAiDeviceCodePollResult> => ({ status: "pending" }))
  };
}

function createAuthService(enabled: boolean): AuthService {
  return new AuthService({
    NODE_ENV: "test",
    PORT: 3000,
    AGENT_DRIVER: "mock",
    HEDDLE_SESSION_STORAGE: "file",
    SLIDEX_PRODUCT_SESSION_STORAGE: "file",
    SLIDEX_AGENT_ENABLED: true,
    DEFAULT_MODEL: "gpt-test",
    LOG_LEVEL: "silent",
    SHUTDOWN_GRACE_MS: 30_000,
    DEV_AUTH_BYPASS: enabled ? "1" : undefined,
    dataDir: "/tmp/slidex-model-auth-test"
  } satisfies Env);
}

async function withHttpServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function readError(response: Response): Promise<{ code?: string }> {
  const body = await response.json() as { error?: { code?: string } };
  return body.error ?? {};
}
