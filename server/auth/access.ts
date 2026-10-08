import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify, type FetchImplementation } from "jose";
import type { AppConfig } from "../config";
import { assertTestOnly, isValidEmail, parseAccessConfig } from "./configuration";

export const JWKS_TIMEOUT_MS = 1500;
export const JWKS_COOLDOWN_MS = 30000;
export const JWKS_CACHE_MAX_AGE_MS = 300000;

/** Synthetic transport only, never JWT/key verification replacement or env-enabled. */
export interface AccessTestOptions { fetch: FetchImplementation }

export function createAccessVerifier(config: AppConfig, testOnly?: AccessTestOptions): (assertion: string | null) => Promise<boolean> {
  if (testOnly) assertTestOnly(config);
  let access;
  try {
    if (!config.access) return async () => false;
    access = parseAccessConfig(config.access.teamDomain, config.access.policyAud, config.access.ownerEmail);
  } catch { return async () => false; }

  const issuer = `https://${access.teamDomain}`;
  let nextFetchAt = 0;
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    timeoutDuration: JWKS_TIMEOUT_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    [customFetch]: async (url, options) => {
      // jose coalesces concurrent fetches; this also bounds failures, not just successes.
      if (Date.now() < nextFetchAt) throw new Error("JWKS fetch cooldown");
      nextFetchAt = Date.now() + JWKS_COOLDOWN_MS;
      return (testOnly?.fetch ?? globalThis.fetch)(url, options);
    },
  });
  return async (assertion) => {
    if (!assertion || assertion.length > 16384) return false;
    try {
      // This is only an early algorithm filter. Identity comes exclusively from jwtVerify.
      if (decodeProtectedHeader(assertion).alg !== "RS256") return false;
      const { payload } = await jwtVerify(assertion, keys, {
        algorithms: ["RS256"], issuer, audience: access.policyAud,
        requiredClaims: ["exp", "iss", "aud", "sub", "email", "type"],
      });
      return payload.type === "app" && typeof payload.sub === "string" && payload.sub.trim().length > 0 &&
        isValidEmail(payload.email) && payload.email === access.ownerEmail;
    } catch {
      // No claims, tokens, key details, transport errors, or identity headers escape.
      return false;
    }
  };
}
