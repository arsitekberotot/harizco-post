# Upstream provenance and fork boundary

Harizco Post is a local-runtime fork of [Cloudflare Agentic Inbox](https://github.com/cloudflare/agentic-inbox), not a UI recreation or an official Cloudflare product.

- Pinned source: `48039bb6785af34e592c2966f87cde2b255c4c80`.
- Upstream license: Apache-2.0. Keep `LICENSE` and existing source copyright/license headers.
- Local implementation branch: `harizco/implementation` (continued from existing implementation commits on `main`; the earlier `harizco/phase-1` branch remains at the upstream baseline).
- Fetch remote: `upstream`, pointing to `https://github.com/cloudflare/agentic-inbox.git`.
- Upstream push URL is intentionally disabled (`no-push://cloudflare/agentic-inbox`). No GitHub fork, writable origin, push, or publication has been authorized.

## Retained frontend

Retain the React 19/React Router mail views, Kumo/Tailwind styling, TanStack Query hooks, Zustand UI state, TipTap composer, sidebar, conversation list/reader, attachment display, and responsive navigation. Keep the browser REST contract at `app/services/api.ts` as the later backend-adapter boundary.

## Deliberate differences

- The active application will use a loopback Node/Hono runtime and a built SPA rather than Workers/SSR.
- No active R2, Durable Object, Workers AI, Cloudflare Email Routing/Email Service, Agents SDK, or MCP dependency is required for the Phase 1 local UI build.
- AI/MCP controls are deferred and removed from the active interface, not shown as functioning features.
- Canonical mail storage and delivery will be implemented in later approved phases using Stalwart and Resend. Phase 1 uses only clearly labeled test fixtures; it is not a working real mailbox.
- Production must fail closed without Cloudflare Access configuration. Fixture preview belongs to the isolated test harness and must not be included in the production runtime or exposed through a tunnel.
- Unused upstream Worker source/configuration can remain as inactive reference material until its planned Phase 6 removal. Do not use its deploy scripts or treat it as the local backend.

## Local plan

The approved source-of-truth plan is `.hermes/plans/2026-10-07_164908-harizco-post.md`. The operator planning/evidence directory is intentionally ignored by Git. Phase 1 implementation does not authorize installing a mail server, persisting real mailbox state, configuring credentials, sending external email, creating Access/Tunnel routes, or changing DNS.
