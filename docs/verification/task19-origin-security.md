# Task 19 — offline origin and authentication verification

## Result and scope

Local source implementation and synthetic verification passed on Node v22.22.2. This is **not** a deployment, real Access-policy verification, live-mail claim, or Task 19 ledger closure.

No real Cloudflare account, policy, tunnel, DNS, hostname, login identity, provider API, mail, credentials, existing Stalwart process, persistent service, or data migration was used or changed. No dependency/package changes, commit, push, reset, stash, or cleanup occurred in this lane. Temporary fixture directories were created only beneath `TMPDIR` and removed by their owning tests. Ephemeral loopback listeners and child processes were closed by their owners.

## Runtime configuration contract

The production web process requires:

| Variable | Contract |
| --- | --- |
| `NODE_ENV` | `production` for production startup; production composition is revalidated, not trusted from `isProduction` alone. |
| `TEAM_DOMAIN` | Lowercase DNS team slug, or exactly `<slug>.cloudflareaccess.com`; no scheme, credentials, IP, port, path, query, fragment, suffix host, or silent repair/trim. |
| `POLICY_AUD` | Nonempty 1–256 character ASCII token containing only letters, digits, `_`, or `-`; the configured application audience is mandatory. |
| `OWNER_EMAIL` | One syntactically valid email address; signed email must match it exactly, including case. An Access team/application policy alone is not mailbox-owner permission. |
| `PUBLIC_ORIGIN` | One literal canonical HTTPS DNS browser origin, e.g. **synthetic** `https://example.invalid`; no credentials, IP, path, trailing slash, query, fragment, or redundant default `:443`. A configured nondefault port is part of the exact authority. |
| `HOST` / `BIND_HOST` | Listener remains `127.0.0.1`; public bind overrides are rejected. |
| `PORT` | Integer 1–65535; default 3000. |
| `CLIENT_DIR` | Trusted built-client directory, normally `dist/client`. It must not be writable by untrusted/runtime-mail inputs. |

Configuration errors and startup failure messages are generic and do not echo input values. The web changes do not modify or load `SyncConfig` credentials.

Access assertions are read only from `cf-access-jwt-assertion`. `jose.jwtVerify` requires RS256 signature, configured issuer `https://<team>.cloudflareaccess.com`, configured audience, expiry, subject, email, and `type: "app"`. Empty/missing human identity, service identity, nonowner, expired/not-yet-valid, wrong issuer/audience, unrelated signature, altered payload, unsigned, malformed, or oversized assertions fail closed. `cf-access-authenticated-user-email`, forwarded headers, `jku`, and `x5u` cannot select identity or keys.

JWKS is fetched only from the configured team's `/cdn-cgi/access/certs`, with manual redirects, 1500 ms abort timeout, 30-second refresh/failure cooldown, five-minute in-memory expiry, and concurrent-fetch coalescing. Expired keys are not used after refresh failure. Missing/invalid configuration and fetch/key errors cannot grant access. Synthetic transport injection is explicit, programmatic, and accepted only when both runtime and composed config are `NODE_ENV=test`, with no production flag. There is no environment-selected key or verification bypass.

Fixture authentication is confined to explicit test composition. It is rejected in production, development, and even when a production config's boolean is forged. The production handler rejects fixture mode regardless of supplied environment; its actual startup always chooses Access mode. Existing fixture-only contract tests remain isolated from production guards.

## Host, Origin, and UI CSRF integration contract

Private requests require the literal `Host` authority from `PUBLIC_ORIGIN`; missing, alternate, combined, suffix, uppercase, trailing-dot, or loopback private-resource Hosts fail closed. `X-Forwarded-Host` and `X-Forwarded-Proto` are ignored. The tunnel must preserve the public Host. The origin transport may legitimately be HTTP on loopback while the browser origin is HTTPS; `Request.url` scheme is **not** an HTTPS authentication requirement.

Every method other than GET/HEAD requires:

1. `Origin` exactly equal to `PUBLIC_ORIGIN` — absent, `null`, foreign, and noncanonical values are denied.
2. **`X-Harizco-CSRF: 1`**, a required non-safelisted custom header.
3. If supplied, `Sec-Fetch-Site: same-origin`. Cross-site reads are denied too; supplied foreign/null read Origin is denied.

No cross-origin CORS permission or credentialed preflight is added. OPTIONS without these requirements is denied. CORS is not treated as the CSRF defense: the exact Origin check plus mandatory custom header enforce the mutation boundary before body parsing or backend calls. The header is a fixed marker, **not a secret token** and not a replacement for Access authentication. Do not enable cross-origin credentialed CORS or weaken the Origin check in a later integration.

**Subsequent UI integration is still required.** A shared browser API client must add the custom header to POST/PATCH/PUT/DELETE and any other unsafe method. For example, within the same public origin:

```ts
await fetch("/api/v1/mailboxes/...", {
  method: "PATCH",
  credentials: "same-origin",
  headers: { "Content-Type": "application/json", "X-Harizco-CSRF": "1" },
  body: JSON.stringify(update),
});
```

The browser supplies Origin/Fetch Metadata; JavaScript must not forge them or the Access assertion. This lane intentionally did not modify the UI API client, DOMPurify, reader, or opaque iframe implementation. Until integration, production mutations lacking the marker remain denied.

## Actual production boundary

`server/index.ts` exports the exact `createProductionHandler` used by the loopback listener. Shared Hono middleware authenticates before private API/backend dispatch or static/SPA body reads. The anonymous health endpoint is restricted to loopback GET/HEAD authority and returns only `{"ok":true}`, with no backend, mode, owner, configuration, or secret information. Public-authority health is denied.

Root/index and known mailbox SPA routes, assets, attachment/download paths, and private APIs are gated. Unknown APIs may return content-free JSON 404, never SPA HTML. Attachment/download functionality is owned separately: this change secures the boundary but does not fabricate a missing implementation. A valid owner with no configured mail backend gets the existing honest 503.

Every private response is `Cache-Control: private, no-store` (including HTML/assets/errors), with nosniff, no-referrer, frame denial, no-index and restrictive frame-ancestor/object/base headers. No private immutable/public caching is retained. Static serving permits only index, known SPA paths, favicons, and constrained hashed build-asset names/extensions. Raw source/maps, invalid encoding, traversal, all static symlinks (including in-root `.js` aliases to `.map`), and admin/JMAP/spool/download fallback paths cannot expose files or the SPA. Realpath confinement, no-follow opening, and opened-file identity checks supplement the filename allowlist.

Importing the source/bundled entrypoint never starts a listener. Actual startup lazily imports `@hono/node-server` and explicitly sets `overrideGlobalObjects: false`. This preserves native Request/Response globals and avoids order-dependent interference with unrelated provider-security tests.

## TDD and verification evidence

Evidence directory: `.hermes/evidence/task19/`.

- `red.log`: tests were written and executed before implementation; missing verifier/composition, unsafe config normalization, missing origin validation, owner authentication and fixture isolation failed for the expected missing behavior.
- `red-symlink.log`: authenticated in-root hashed `.js` symlink to raw `.map` reproduced **200 instead of 404**. The assertion was preserved; runtime symlink serving was removed.
- `red-global-shim.log`: real loopback adapter reproduced global Request replacement. The production adapter is now lazy and explicitly opts out of global overrides; unrelated Resend tests were not modified.
- `focused-final.log`: `npm test -- tests/security/access.test.ts tests/security/request-origin.test.ts` — **109 passed**.
- `production-final.log`: production handler, runtime and unchanged Resend security tests — **72 passed**. Includes actual Node HTTP adapter, positive/negative owner assertions, static/SPA gates, zero backend/body calls on denial, and global-constructor preservation.
- `full-test-final.log`: `npm test` — **382 passed, 11 skipped**; the skips are the optional real Stalwart fixture integration, intentionally not run in this offline scope.
- `typecheck-final.log`: `npm run typecheck` — exit 0.
- `build-final.log`: `npm run build` — exit 0 (client, bundled web server, bundled worker).
- `built-smoke-final.log`: actual built handler verifies real synthetic RSA JWTs against in-memory JWKS, serves owner-only shell/deeplink/build asset, returns honest backend 503, denies unsafe paths, and caches keys. Actual exported startup preserves native globals. Direct CLI startup rejects incomplete config/bypass/public bind; the owned loopback child gates private routes and returns only content-free local health, then exits. The child has an explicit network-denying preload; no real provider calls are allowed.
- `diff-check-final.log`: `git diff --check` — exit 0.
- `baseline-status.txt`, `baseline-sha256.json`, `scope-verification.json`, `final-status.txt`: preexisting dirty state and scoped preservation proof. `SyncConfig` and `handlePrivateRoute`/DTO implementation match HEAD exactly. Three parent-lane registry/setup/test files changed since the snapshot; this lane did not edit them.

Synthetic RSA private keys live only in memory and are never printed or persisted. New security tests stub the fixed JWKS transport; no JWT verification is mocked and no external network is used. Verification runner explicitly unsets optional live-Stalwart fixture activation variables for the full suite.

## Files and remaining gates

Runtime: `server/auth/{configuration,access,request}.ts`; owned web sections of `server/config.ts`, `server/app.ts`, and `server/index.ts`.

Tests: `tests/security/{fixtures,access.test,request-origin.test}.ts`, `tests/server/production-security.test.ts`; narrow synthetic-origin and local-health updates in `tests/helpers/app.ts` and `tests/server/runtime.test.ts`.

Still deferred: real public hostname, independent human login identity, Access application/policy, Tunnel/DNS and preserved-Host validation, real JWT/rotation/outage behavior with that account, live deployment, UI CSRF-header integration, authenticated attachment implementation/wiring, and production mail-backend composition. These require separate authorization and verification. The local green result does not establish any of them.
