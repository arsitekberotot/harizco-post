import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadConfig } from "../../server/config";
import { certsUrl, jwtFixture, privateRequest, securityEnv } from "../security/fixtures";

let fixture: Awaited<ReturnType<typeof jwtFixture>>;
let owner: string;
let root: string;
let client: string;
beforeAll(async () => {
  fixture = await jwtFixture(); owner = await fixture.sign();
  if (!process.env.TMPDIR) throw new Error("TMPDIR required");
  root = await mkdtemp(join(process.env.TMPDIR, "task19-security-")); client = join(root, "client");
  await mkdir(join(client, "assets"), { recursive: true });
  await writeFile(join(client, "index.html"), "<!doctype html><p>synthetic private shell</p>");
  await writeFile(join(client, "assets", "bundle-AbCd1234.js"), "/* synthetic build asset */");
  await writeFile(join(client, "assets", "bundle-AbCd1234.js.map"), "source-map-must-not-be-exposed");
  await writeFile(join(client, "server.ts"), "raw-source-must-not-be-exposed");
  await writeFile(join(root, "outside.js"), "symlink-target-must-not-be-exposed");
  await symlink(join(root, "outside.js"), join(client, "assets", "escape-AbCd1234.js"));
  await symlink(join(root, "outside.js"), join(client, "shell-link.html"));
  await symlink(join(client, "assets", "bundle-AbCd1234.js.map"), join(client, "assets", "source-AbCd1234.js"));
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async (url: string) => { expect(url).toBe(certsUrl); return Response.json(fixture.jwks); })); });
afterEach(() => { vi.unstubAllGlobals(); });

async function handler() {
  // RED must not import the old entrypoint: that would start a real listener.
  const source = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
  expect(source, "production handler composition must exist without import-listener side effects").toContain("export function createProductionHandler");
  const { createProductionHandler } = await import("../../server/index");
  const record = vi.fn();
  const fetch = createProductionHandler({
    config: loadConfig({ ...securityEnv, NODE_ENV: "production" }), clientDir: client,
    mailStore: { record, listMailboxes: vi.fn() },
  });
  return { fetch, record };
}

test.each(["/", "/index.html", "/mailbox/owner/emails/inbox", "/assets/bundle-AbCd1234.js", "/api/v1/mailboxes", "/api/v1/mailboxes/mb/emails/e/attachments/a", "/attachments/a", "/download/a"])("actual production handler authenticates %s before file/backend access", async (path) => {
  const { fetch, record } = await handler();
  for (const assertion of [undefined, "bad-jwt", await fixture.sign({ email: "other@example.invalid" })]) {
    const response = await fetch(privateRequest(path, assertion ? { "cf-access-jwt-assertion": assertion } : {}));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(record).not.toHaveBeenCalled();
});
test.each(["/", "/index.html", "/mailbox/owner/emails/inbox", "/assets/bundle-AbCd1234.js"])("verified owner receives private no-store resource %s", async (path) => {
  const { fetch } = await handler();
  const response = await fetch(privateRequest(path, { "cf-access-jwt-assertion": owner }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(await response.text()).toContain(path.startsWith("/assets/") ? "synthetic build asset" : "synthetic private shell");
});
test.each(["/server.ts", "/assets/bundle-AbCd1234.js.map", "/assets/escape-AbCd1234.js", "/assets/source-AbCd1234.js", "/shell-link.html", "/assets/%2e%2e%2fserver.ts", "/assets/%2e%2e%2f%2e%2e%2foutside.js", "/assets/%252e%252e%252foutside.js", "/assets/%5coutside.js", "/assets/%00.js", "/assets/%ZZ.js", "/admin", "/jmap/session", "/spool/file.eml", "/.env", "/server/config", "/attachments/a", "/download/a"])("verified owner cannot expose unsafe file/SPA path %s", async (path) => {
  const { fetch } = await handler();
  const response = await fetch(privateRequest(path, { "cf-access-jwt-assertion": owner }));
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("json");
  expect(await response.text()).not.toMatch(/synthetic private shell|must-not-be-exposed/);
});
test("private HEAD is gated, bodyless, and uncacheable", async () => {
  const { fetch } = await handler();
  expect((await fetch(privateRequest("/", {}, "HEAD"))).status).toBe(403);
  const response = await fetch(privateRequest("/", { "cf-access-jwt-assertion": owner }, "HEAD"));
  expect(response.status).toBe(200); expect(await response.text()).toBe("");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
test("static mutations are rejected and never serve shell", async () => {
  const { fetch, record } = await handler();
  expect((await fetch(privateRequest("/", { "cf-access-jwt-assertion": owner }, "POST"))).status).toBe(403);
  const response = await fetch(privateRequest("/", { "cf-access-jwt-assertion": owner, origin: securityEnv.PUBLIC_ORIGIN, "x-harizco-csrf": "1" }, "POST"));
  expect(response.status).toBe(405); expect(await response.text()).not.toContain("synthetic private shell");
  expect(record).not.toHaveBeenCalled();
});
test("owner without a mail backend receives honest 503; unknown API receives JSON 404", async () => {
  const { fetch, record } = await handler();
  expect((await fetch(privateRequest("/api/v1/mailboxes", { "cf-access-jwt-assertion": owner }))).status).toBe(503);
  expect(record).toHaveBeenCalledTimes(1);
  const response = await fetch(privateRequest("/api/no-such-route"));
  expect(response.status).toBe(404); expect(response.headers.get("content-type")).toContain("json");
});
test("production handler rejects explicit fixture and transport test seams", async () => {
  await handler();
  const { createProductionHandler } = await import("../../server/index");
  const config = loadConfig({ ...securityEnv, NODE_ENV: "production" });
  expect(() => createProductionHandler({ config, clientDir: client, authMode: "fixture" })).toThrow(/fixture|production/i);
  expect(() => createProductionHandler({ config, clientDir: client, accessTestOptions: { fetch: vi.fn() } })).toThrow(/test|production/i);
});
test("symlinked index.html cannot escape the client root", async () => {
  const { fetch: _fetch } = await handler();
  const { createProductionHandler } = await import("../../server/index");
  const other = join(root, "other-client"); await mkdir(other);
  await symlink(join(root, "outside.js"), join(other, "index.html"));
  const fetch = createProductionHandler({ config: loadConfig({ ...securityEnv, NODE_ENV: "production" }), clientDir: other });
  expect((await fetch(privateRequest("/", { "cf-access-jwt-assertion": owner }))).status).toBe(404);
});
test("actual Hono Node adapter gates a synthetic loopback listener and tears down only itself", async () => {
  const { fetch } = await handler();
  const nativeRequest = globalThis.Request;
  const nativeResponse = globalThis.Response;
  // Capture originals before the adapter runs so even a RED cannot pollute other lanes.
  vi.stubGlobal("Request", nativeRequest); vi.stubGlobal("Response", nativeResponse);
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch, overrideGlobalObjects: false });
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Listener address missing");
  const port = address.port;
  function get(path: string, host: string, assertion?: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path, headers: { host, ...(assertion ? { "cf-access-jwt-assertion": assertion } : {}) } }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", value => { body += value; }); res.on("end", () => resolve({ status: res.statusCode!, body }));
      }); req.on("error", reject); req.end();
    });
  }
  try {
    expect(globalThis.Request, "adapter must not replace the process Request constructor").toBe(nativeRequest);
    expect(globalThis.Response, "adapter must not replace the process Response constructor").toBe(nativeResponse);
    const response = Response.json({});
    expect(() => { response.json = async () => ({}); }).not.toThrow();
    expect((await get("/", "example.invalid")).status).toBe(403);
    expect((await get("/", "example.invalid", owner)).body).toContain("synthetic private shell");
    expect((await get("/", "evil.example.invalid", owner)).status).toBe(403);
    expect((await get("/health", "127.0.0.1:" + address.port)).body).toBe('{"ok":true}');
    expect((await get("/health", "example.invalid")).status).toBe(403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
