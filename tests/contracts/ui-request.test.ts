// Browser request construction and the real Access/Origin gate, not live mail.
import { afterEach, describe, expect, test, vi } from "vitest";
import api from "../../app/services/api";
import { createApp } from "../../server/app";
import type { MailBackend } from "../../server/mail/backend";
import { jwtFixture, origin, publicHost, securityConfig } from "../security/fixtures";

afterEach(() => vi.unstubAllGlobals());

const unsafeRequests: [string, () => Promise<unknown>][] = [
  ["POST", () => api.createFolder("mailbox-fixture", "Fixtures")],
  ["PUT", () => api.updateEmail("mailbox-fixture", "email-fixture", { read: true })],
  ["DELETE", () => api.deleteEmail("mailbox-fixture", "email-fixture")],
];

describe("browser CSRF request contract", () => {
  test.each(unsafeRequests)("%s adds the required fixed marker and same-origin credentials", async (method, send) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await send();
    const [, options] = fetcher.mock.calls[0];
    expect(options?.method).toBe(method);
    expect(new Headers(options?.headers).get("x-harizco-csrf")).toBe("1");
    expect(options?.credentials).toBe("same-origin");
  });

  test("GET does not invent Origin, Access assertions or a CSRF marker", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ domains: [], emailAddresses: [] }));
    vi.stubGlobal("fetch", fetcher);
    await api.getConfig();
    const [, options] = fetcher.mock.calls[0];
    const headers = new Headers(options?.headers);
    for (const key of ["origin", "host", "cf-access-jwt-assertion", "cf-access-authenticated-user-email", "x-harizco-csrf"]) {
      expect(headers.get(key)).toBeNull();
    }
  });

  test.each([true, false])("real signed-owner gate permits the client only with edge identity present=%s", async identityPresent => {
    const fixture = await jwtFixture();
    const assertion = await fixture.sign();
    const createFolder = vi.fn<MailBackend["createFolder"]>(async () => ({ id: "folder-fixture" }));
    // Explicit counting backend: only authentication/dispatch is under test.
    // No JMAP/provider operation or canonical folder creation is claimed.
    const backend = { createFolder } as unknown as MailBackend;
    const app = createApp({ config: securityConfig(), authMode: "access", backend,
      accessTestOptions: { fetch: async () => Response.json(fixture.jwks) } });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, options) => {
      const browserHeaders = new Headers(options?.headers);
      expect(browserHeaders.has("origin")).toBe(false);
      expect(browserHeaders.has("cf-access-jwt-assertion")).toBe(false);
      // Model browser-supplied Origin and edge-injected assertion at the trusted
      // transport boundary; the actual client must not forge either header.
      const headers = new Headers(browserHeaders);
      headers.set("host", publicHost);
      headers.set("origin", origin);
      if (identityPresent) headers.set("cf-access-jwt-assertion", assertion);
      return app.fetch(new Request(origin + String(input), { ...options, headers }));
    }));
    if (identityPresent) {
      await expect(api.createFolder("mailbox-fixture", "Fixtures")).resolves.toEqual({ id: "folder-fixture" });
      expect(createFolder).toHaveBeenCalledOnce();
      expect(createFolder).toHaveBeenCalledWith({ name: "Fixtures", parentId: null });
    } else {
      await expect(api.createFolder("mailbox-fixture", "Fixtures")).rejects.toMatchObject({ status: 403 });
      expect(createFolder).not.toHaveBeenCalled();
    }
  });
});
