import assert from "node:assert/strict";
import test from "node:test";
import { loadEnv } from "./env.js";

test("requires an explicit CORS allowlist for a production agent", () => {
  assert.throws(
    () => loadEnv(productionAgentEnv()),
    /CORS_ORIGIN must list explicit browser origins/
  );
  assert.throws(
    () => loadEnv(productionAgentEnv({ CORS_ORIGIN: "*" })),
    /CORS_ORIGIN must list explicit browser origins/
  );
});

test("accepts normalized production origins and preserves the disabled upstream default", () => {
  assert.doesNotThrow(() => loadEnv(productionAgentEnv({
    CORS_ORIGIN: "https://Editor.Example/, https://preview.example"
  })));
  assert.doesNotThrow(() => loadEnv({
    NODE_ENV: "production",
    SLIDEX_AGENT_ENABLED: "false"
  }));
});

test("rejects URLs that are not browser origins", () => {
  assert.throws(
    () => loadEnv(productionAgentEnv({
      CORS_ORIGIN: "https://editor.example/private"
    })),
    /without paths/
  );
});

test("keeps file-backed Heddle sessions as the default", () => {
  assert.equal(loadEnv({ NODE_ENV: "test" }).HEDDLE_SESSION_STORAGE, "file");
});

test("requires trusted server credentials for Supabase Heddle sessions", () => {
  assert.throws(
    () => loadEnv({
      NODE_ENV: "test",
      HEDDLE_SESSION_STORAGE: "supabase"
    }),
    /SUPABASE_URL is required/
  );
  assert.throws(
    () => loadEnv({
      NODE_ENV: "test",
      HEDDLE_SESSION_STORAGE: "supabase",
      SUPABASE_URL: "https://example.supabase.co"
    }),
    /SUPABASE_SERVICE_ROLE_KEY is required/
  );
  assert.equal(loadEnv({
    NODE_ENV: "test",
    HEDDLE_SESSION_STORAGE: "supabase",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key"
  }).HEDDLE_SESSION_STORAGE, "supabase");
});

function productionAgentEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    SLIDEX_AGENT_ENABLED: "true",
    ...overrides
  };
}
