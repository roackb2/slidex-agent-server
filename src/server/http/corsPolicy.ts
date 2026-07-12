import type { CorsOptions } from "cors";

type CorsPolicyOptions = {
  requireExplicitAllowlist?: boolean;
};

export function createCorsOriginPolicy(
  configuredOrigins?: string,
  options: CorsPolicyOptions = {}
): CorsOptions["origin"] {
  const issue = corsConfigurationIssue(configuredOrigins, options);
  if (issue) {
    throw new Error(issue);
  }

  const allowedOrigins = parseCorsOrigins(configuredOrigins);
  if (allowedOrigins === true) {
    return true;
  }

  return (requestOrigin, callback) => {
    callback(null, !requestOrigin || allowedOrigins.has(requestOrigin));
  };
}

export function corsConfigurationIssue(
  configuredOrigins?: string,
  options: CorsPolicyOptions = {}
): string | undefined {
  try {
    const allowedOrigins = parseCorsOrigins(configuredOrigins);
    if (options.requireExplicitAllowlist && allowedOrigins === true) {
      return "CORS_ORIGIN must list explicit browser origins when the agent is enabled in production";
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "CORS_ORIGIN is invalid";
  }
}

function parseCorsOrigins(configuredOrigins?: string): true | ReadonlySet<string> {
  const value = configuredOrigins?.trim();
  if (!value || value === "*") {
    return true;
  }

  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !entry || entry === "*")) {
    throw new Error("CORS_ORIGIN must be either * or a comma-separated list of origins");
  }
  return new Set(entries.map(normalizeConfiguredOrigin));
}

function normalizeConfiguredOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`CORS_ORIGIN contains an invalid origin: ${value}`);
  }

  const isHttpOrigin = url.protocol === "http:" || url.protocol === "https:";
  const hasOnlyOrigin =
    !url.username
    && !url.password
    && url.pathname === "/"
    && !url.search
    && !url.hash;
  if (!isHttpOrigin || !hasOnlyOrigin) {
    throw new Error(`CORS_ORIGIN must contain only HTTP(S) origins without paths: ${value}`);
  }
  return url.origin;
}
