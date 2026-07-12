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

function productionAgentEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    SLIDEX_AGENT_ENABLED: "true",
    ...overrides
  };
}
