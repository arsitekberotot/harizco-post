import { exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTHeaderParameters } from "jose";
import { loadConfig } from "../../server/config";

export const securityEnv = {
  NODE_ENV: "test",
  TEAM_DOMAIN: "example.cloudflareaccess.com",
  POLICY_AUD: "test-policy-aud",
  OWNER_EMAIL: "owner@example.invalid",
  PUBLIC_ORIGIN: "https://example.invalid",
};
export const securityConfig = () => loadConfig(securityEnv);
export const publicHost = "example.invalid";
export const origin = "https://example.invalid";
export const issuer = "https://example.cloudflareaccess.com";
export const certsUrl = issuer + "/cdn-cgi/access/certs";

// Private keys stay in memory, are synthetic, and are never logged or persisted.
export async function jwtFixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "synthetic-key", alg: "RS256", use: "sig" };
  async function sign(payload: JWTPayload = {}, header: JWTHeaderParameters = { alg: "RS256" }) {
    const claims: JWTPayload = {
      iss: issuer, aud: securityEnv.POLICY_AUD, sub: "synthetic-human-owner",
      email: securityEnv.OWNER_EMAIL, type: "app", exp: Math.floor(Date.now() / 1000) + 600,
      ...payload,
    };
    return new SignJWT(claims).setProtectedHeader({ kid: jwk.kid, ...header }).sign(privateKey);
  }
  return { jwks: { keys: [jwk] }, sign };
}

export function privateRequest(path = "/api/v1/mailboxes", headers: Record<string, string> = {}, method = "GET") {
  return new Request("http://127.0.0.1:3000" + path, { method, headers: { host: publicHost, ...headers } });
}
