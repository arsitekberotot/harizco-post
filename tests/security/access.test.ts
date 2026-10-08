import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SignJWT, UnsecuredJWT, type JWTPayload, type FetchImplementation } from "jose";
import { createApp } from "../../server/app";
import type { MailBackend } from "../../server/mail/backend";
import { loadConfig } from "../../server/config";
import { certsUrl, issuer, jwtFixture, privateRequest, securityConfig, securityEnv } from "./fixtures";

const moduleResult = await Promise.allSettled([import("../../server/auth/access")]);
function accessModule(): typeof import("../../server/auth/access") {
  const result = moduleResult[0];
  if (result.status === "rejected") throw new Error("Access verifier is not implemented", { cause: result.reason });
  return result.value;
}
let fixture: Awaited<ReturnType<typeof jwtFixture>>;
beforeAll(async () => { fixture = await jwtFixture(); });
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("External network forbidden"); })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function verifier(fetcher = vi.fn<FetchImplementation>(async () => Response.json(fixture.jwks))) {
  return { verify: accessModule().createAccessVerifier(securityConfig(), { fetch: fetcher }), fetcher };
}

describe("real Access JWT verification", () => {
  test("RS256 owner signed by the configured team's JWKS is accepted", async () => {
    const { verify, fetcher } = verifier();
    expect(await verify(await fixture.sign())).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(certsUrl);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual", method: "GET" });
  });
  test.each([
    ["nonowner", { email: "other@example.invalid" }],
    ["absent email", { email: undefined }],
    ["invalid email", { email: "owner@example.invalid,other@example.invalid" }],
    ["no subject", { sub: undefined }],
    ["empty subject", { sub: "" }],
    ["service identity", { type: "service" }],
    ["wrong issuer", { iss: "https://evil.example.invalid" }],
    ["wrong audience", { aud: "different-audience" }],
    ["absent expiry", { exp: undefined }],
    ["expired", { exp: 1 }],
    ["future nbf", { nbf: 9999999999 }],
  ] satisfies [string, JWTPayload][])("rejects %s", async (_name, claims) => {
    expect(await verifier().verify(await fixture.sign(claims))).toBe(false);
  });
  test.each([null, "", "not.a.jwt", "e30.e30.", "x".repeat(17000),
    new UnsecuredJWT({ iss: issuer, aud: securityEnv.POLICY_AUD, email: securityEnv.OWNER_EMAIL, sub: "unsigned-human", type: "app", exp: 9999999999 }).encode(),
  ])("rejects missing/malformed/unsigned/oversized assertion", async (assertion) => {
    const { verify, fetcher } = verifier();
    expect(await verify(assertion)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  test("rejects wrong algorithm without key fetch", async () => {
    const key = new Uint8Array(32).fill(7);
    const token = await new SignJWT({ email: securityEnv.OWNER_EMAIL }).setProtectedHeader({ alg: "HS256" }).sign(key);
    const { verify, fetcher } = verifier();
    expect(await verify(token)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  test("rejects a valid JWT signed by an unrelated RSA key", async () => {
    const other = await jwtFixture();
    expect(await verifier().verify(await other.sign())).toBe(false);
  });
  test("rejects tampered payload", async () => {
    const token = await fixture.sign({ email: "other@example.invalid" });
    const [header, body, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    claims.email = securityEnv.OWNER_EMAIL;
    const tampered = [header, Buffer.from(JSON.stringify(claims)).toString("base64url"), signature].join(".");
    expect(await verifier().verify(tampered)).toBe(false);
  });
  test("jku/x5u never select discovery or keys", async () => {
    const { verify, fetcher } = verifier();
    expect(await verify(await fixture.sign({}, { alg: "RS256", jku: "https://evil.example.invalid/jwks", x5u: "http://127.0.0.1/private" }))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(certsUrl);
  });
  test("cached keys coalesce concurrent fetches and limit unknown-kid refreshes", async () => {
    const { verify, fetcher } = verifier();
    const owner = await fixture.sign();
    expect(await Promise.all(Array.from({ length: 8 }, () => verify(owner)))).toEqual(Array(8).fill(true));
    for (let n = 0; n < 4; n++) expect(await verify(await fixture.sign({}, { alg: "RS256", kid: "unknown-" + n }))).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test("expired cache refetches and a fetch outage cannot use stale keys", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { verify, fetcher } = verifier();
    expect(await verify(await fixture.sign())).toBe(true);
    vi.advanceTimersByTime(accessModule().JWKS_CACHE_MAX_AGE_MS + 1);
    fetcher.mockRejectedValue(new Error("synthetic outage"));
    expect(await verify(await fixture.sign())).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  test("failed fetches have a cooldown and recover only after it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetcher = vi.fn<FetchImplementation>(async () => { throw new Error("synthetic outage"); });
    const { verify } = verifier(fetcher);
    const token = await fixture.sign();
    expect(await verify(token)).toBe(false);
    expect(await verify(token)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(accessModule().JWKS_COOLDOWN_MS + 1);
    fetcher.mockImplementation(async () => Response.json(fixture.jwks));
    expect(await verify(token)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  test("JWKS timeout aborts a stalled transport and fails closed", async () => {
    const fetcher = vi.fn((_url: string, options: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const { verify } = verifier(fetcher);
    expect(await verify(await fixture.sign())).toBe(false);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  }, 5000);
  test.each([() => new Response("redirect", { status: 302 }), () => new Response("not json"), () => Response.json({ keys: [] })])("key response failure denies", async (response) => {
    expect(await verifier(vi.fn(async () => response())).verify(await fixture.sign())).toBe(false);
  });
  test("missing config fails closed without fetching", async () => {
    const fetcher = vi.fn(async () => Response.json(fixture.jwks));
    const verify = accessModule().createAccessVerifier(loadConfig({ NODE_ENV: "test" }), { fetch: fetcher });
    expect(await verify(await fixture.sign())).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  test("test transport seam is rejected outside test composition", () => {
    for (const NODE_ENV of ["production", "development"]) {
      expect(() => accessModule().createAccessVerifier(loadConfig({ ...securityEnv, NODE_ENV }), { fetch: vi.fn() })).toThrow(/test|production/i);
    }
  });
  test("production composition rejects fixture mode even when its boolean is forged", () => {
    const config = loadConfig({ ...securityEnv, NODE_ENV: "production" });
    expect(() => createApp({ config, authMode: "fixture" })).toThrow(/fixture|production/i);
    expect(() => createApp({ config: { ...config, isProduction: false }, authMode: "fixture" })).toThrow(/fixture|production/i);
    expect(() => createApp({ config: loadConfig({ NODE_ENV: "development" }), authMode: "fixture" })).toThrow(/test|fixture/i);
  });
  test("production API verifies real signature and owner before touching a backend", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe(certsUrl); return Response.json(fixture.jwks);
    }));
    const record = vi.fn();
    const app = createApp({ config: loadConfig({ ...securityEnv, NODE_ENV: "production" }), mailStore: { record, listMailboxes: vi.fn() } });
    const owner = await app.fetch(privateRequest(undefined, { "cf-access-jwt-assertion": await fixture.sign() }));
    expect(owner.status).toBe(503);
    expect(record).toHaveBeenCalledTimes(1);
    record.mockClear();
    for (const token of ["malformed", await fixture.sign({ email: "other@example.invalid" })]) {
      const denied = await app.fetch(privateRequest(undefined, { "cf-access-jwt-assertion": token, "cf-access-authenticated-user-email": securityEnv.OWNER_EMAIL }));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "Forbidden" });
      expect(denied.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(record).not.toHaveBeenCalled();
  });
  test("all invalid assertion classes leave the actual backend untouched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(fixture.jwks)));
    const call = vi.fn();
    const backend = new Proxy({} as MailBackend, { get: () => (...args: unknown[]) => { call(...args); throw new Error("Backend must not execute"); } });
    const app = createApp({ config: loadConfig({ ...securityEnv, NODE_ENV: "production" }), backend });
    const other = await jwtFixture();
    for (const assertion of [undefined, "bad.jwt", "e30.e30.", await other.sign(), await fixture.sign({ exp: 1 }),
      await fixture.sign({ aud: "wrong-audience" }), await fixture.sign({ iss: "https://evil.example.invalid" }),
      await fixture.sign({ email: "other@example.invalid" }), await fixture.sign({ email: undefined })]) {
      const response = await app.fetch(privateRequest(undefined, assertion ? { "cf-access-jwt-assertion": assertion } : {}));
      expect(response.status).toBe(403);
    }
    expect(call).not.toHaveBeenCalled();
  });
});
