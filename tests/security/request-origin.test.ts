import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../../server/app";
import type { MailBackend } from "../../server/mail/backend";
import { loadConfig } from "../../server/config";
import { certsUrl, jwtFixture, origin, privateRequest, securityEnv } from "./fixtures";

let fixture: Awaited<ReturnType<typeof jwtFixture>>;
let token: string;
beforeAll(async () => { fixture = await jwtFixture(); token = await fixture.sign(); });
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async (url: string) => { expect(url).toBe(certsUrl); return Response.json(fixture.jwks); })); });
afterEach(() => { vi.unstubAllGlobals(); });

const baseHeaders = () => ({ "cf-access-jwt-assertion": token, origin, "x-harizco-csrf": "1", "sec-fetch-site": "same-origin" });
function appProbe() {
  const record = vi.fn();
  const app = createApp({ config: loadConfig({ ...securityEnv, NODE_ENV: "production" }), mailStore: { record, listMailboxes: vi.fn() } });
  return { app, record };
}

describe("strict origin configuration", () => {
  test.each(["example", "example.cloudflareaccess.com"])("accepts only a team slug or exact Access hostname: %s", (TEAM_DOMAIN) => {
    expect(loadConfig({ ...securityEnv, TEAM_DOMAIN }).access?.teamDomain).toBe("example.cloudflareaccess.com");
  });
  test.each(["http://example.cloudflareaccess.com", "https://example.cloudflareaccess.com", "example.cloudflareaccess.com/", "user@example.cloudflareaccess.com", "127.0.0.1", "[::1]", "example.cloudflareaccess.com:443", "example.cloudflareaccess.com:8443", "example.cloudflareaccess.com/path", "example.cloudflareaccess.com?secret=redacted", "example.cloudflareaccess.com#fragment", "evil.example.invalid", "example.cloudflareaccess.com.evil.example.invalid", "-bad", "a_b", "example..cloudflareaccess.com"])("rejects hostile TEAM_DOMAIN %s with generic errors", (TEAM_DOMAIN) => {
    expect(() => loadConfig({ ...securityEnv, TEAM_DOMAIN })).toThrow("Invalid Access configuration");
  });
  test.each([
    { OWNER_EMAIL: "" }, { OWNER_EMAIL: "not-an-email" }, { OWNER_EMAIL: "a@b" }, { OWNER_EMAIL: "owner@example.invalid\nother@example.invalid" },
    { POLICY_AUD: "" }, { POLICY_AUD: "aud with spaces" }, { POLICY_AUD: "a,b" },
  ])("rejects invalid owner/audience without reflecting input", (overrides) => {
    expect(() => loadConfig({ ...securityEnv, ...overrides, NODE_ENV: "production" })).toThrow(/Access configuration/i);
  });
  test.each([undefined, "", "http://example.invalid", "https://user:pass@example.invalid", "https://127.0.0.1", "https://[::1]", "https://example.invalid/", "https://example.invalid/path", "https://example.invalid?x=y", "https://example.invalid#fragment", "https://example.invalid:443"])("rejects absent or noncanonical PUBLIC_ORIGIN %s", (PUBLIC_ORIGIN) => {
    expect(() => loadConfig({ ...securityEnv, NODE_ENV: "production", PUBLIC_ORIGIN })).toThrow(/PUBLIC_ORIGIN/i);
  });
  test.each(["FIXTURE_AUTH_BYPASS", "ALLOW_FIXTURE_AUTH", "DEV_AUTH_BYPASS", "AUTH_BYPASS"])("rejects production env bypass %s", (flag) => {
    expect(() => loadConfig({ ...securityEnv, NODE_ENV: "production", [flag]: "true" })).toThrow(/bypass/i);
  });
});

describe("Host, Origin, and CSRF are independent gates", () => {
  test("Host/Origin/CSRF denial leaves the actual backend untouched", async () => {
    const call = vi.fn();
    const backend = new Proxy({} as MailBackend, { get: () => (...args: unknown[]) => { call(...args); throw new Error("Backend must not execute"); } });
    const app = createApp({ config: loadConfig({ ...securityEnv, NODE_ENV: "production" }), backend });
    const cases: Record<string, string>[] = [{ host: "evil.example.invalid" }, { origin: "https://evil.example.invalid" },
      { origin: "null" }, { "x-harizco-csrf": "" }, { "sec-fetch-site": "cross-site" }];
    for (const overrides of cases) {
      const request = privateRequest(undefined, { ...baseHeaders(), ...overrides }, "POST");
      const body = vi.spyOn(request, "json");
      expect((await app.fetch(request)).status).toBe(403); expect(body).not.toHaveBeenCalled();
    }
    expect(call).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  test("public Host and browser Origin are accepted over HTTP loopback transport", async () => {
    const { app, record } = appProbe();
    const response = await app.fetch(privateRequest(undefined, baseHeaders(), "POST"));
    expect(response.status).toBe(503);
    expect(record).toHaveBeenCalledTimes(1);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
  test.each(["", "evil.example.invalid", "example.invalid.evil.example.invalid", "example.invalid:443", "example.invalid:444", "example.invalid,evil.example.invalid", "EXAMPLE.INVALID", "example.invalid.", "127.0.0.1:3000"])("rejects nonexact Host %s even with forged forwarding", async (host) => {
    const { app, record } = appProbe();
    const response = await app.fetch(privateRequest(undefined, { ...baseHeaders(), host, "x-forwarded-host": "example.invalid", "x-forwarded-proto": "https" }));
    expect(response.status).toBe(403);
    expect(record).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  test("missing Host cannot be rescued by URL or X-Forwarded-Host", async () => {
    const { app, record } = appProbe();
    const response = await app.fetch(new Request(origin + "/api/v1/mailboxes", { headers: { "cf-access-jwt-assertion": token, "x-forwarded-host": "example.invalid" } }));
    expect(response.status).toBe(403); expect(record).not.toHaveBeenCalled();
  });
  test.each(["POST", "PATCH", "PUT", "DELETE", "OPTIONS"])("requires Origin and custom header before %s body consumption", async (method) => {
    const { app, record } = appProbe();
    const request = privateRequest(undefined, { "cf-access-jwt-assertion": token }, method);
    const body = vi.spyOn(request, "json");
    expect((await app.fetch(request)).status).toBe(403);
    expect(record).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  test.each(["", "null", "https://evil.example.invalid", origin + "/", origin + ".evil.example.invalid", "http://example.invalid", origin + ":443"])("rejects hostile mutation Origin %s", async (badOrigin) => {
    const { app, record } = appProbe();
    const response = await app.fetch(privateRequest(undefined, { ...baseHeaders(), origin: badOrigin }, "PATCH"));
    expect(response.status).toBe(403); expect(record).not.toHaveBeenCalled();
  });
  test.each(["", "true", "2"])("requires exact custom CSRF header value %s", async (value) => {
    const { app, record } = appProbe();
    const response = await app.fetch(privateRequest(undefined, { ...baseHeaders(), "x-harizco-csrf": value }, "DELETE"));
    expect(response.status).toBe(403); expect(record).not.toHaveBeenCalled();
  });
  test.each(["cross-site", "same-site", "none", "garbage"])("rejects mutation Fetch Metadata %s", async (site) => {
    const { app, record } = appProbe();
    const response = await app.fetch(privateRequest(undefined, { ...baseHeaders(), "sec-fetch-site": site }, "POST"));
    expect(response.status).toBe(403); expect(record).not.toHaveBeenCalled();
  });
  test("cross-site reads are denied and no permissive CORS headers appear", async () => {
    const { app, record } = appProbe();
    const response = await app.fetch(privateRequest(undefined, { ...baseHeaders(), "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(403); expect(record).not.toHaveBeenCalled();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
  test("foreign/null read Origin is denied when supplied", async () => {
    const { app, record } = appProbe();
    for (const supplied of ["null", "https://evil.example.invalid"]) expect((await app.fetch(privateRequest(undefined, { ...baseHeaders(), origin: supplied }))).status).toBe(403);
    expect(record).not.toHaveBeenCalled();
  });
  test("same-origin mutation without Fetch Metadata still requires Origin and header", async () => {
    const { app } = appProbe();
    const headers: Record<string, string> = baseHeaders(); delete headers["sec-fetch-site"];
    expect((await app.fetch(privateRequest(undefined, headers, "PATCH"))).status).toBe(503);
  });
  test("only loopback health is anonymous and returns no configuration", async () => {
    const { app, record } = appProbe();
    const local = await app.fetch(new Request("http://127.0.0.1:3000/health", { headers: { host: "127.0.0.1:3000" } }));
    expect(local.status).toBe(200); expect(await local.json()).toEqual({ ok: true });
    expect(local.headers.get("cache-control")).toBe("private, no-store");
    expect((await app.fetch(privateRequest("/health"))).status).toBe(403);
    expect(record).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
