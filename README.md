# Harizco Post

**Your domains. One inbox.**

Harizco Post forks the mail UI from [Cloudflare Agentic Inbox](https://github.com/cloudflare/agentic-inbox) and ports its runtime to the homelab. It is not an official Cloudflare product. See [upstream provenance](docs/upstream.md) for the exact source commit and retained license.

## Implementation status

Phase 1’s retained UI and loopback production build are verified. A real isolated Stalwart 0.16.25 fixture spike also round-trips MIME and attachments and exercises crash-reconciliation primitives. This is **not yet a working production mailbox**: the UI/API adapter, production importer, outbound relay, Access/Tunnel, DNS pilot and independent backup/restore gates remain incomplete. See [execution ledger](docs/verification/progress.md) and [JMAP capability evidence](docs/spikes/stalwart-jmap.md).

The approved local plan is `.hermes/plans/2026-10-07_164908-harizco-post.md`. It contains later installation, credentials, external-mail, authentication, Tunnel, and DNS approval gates.

## Intended architecture

- **UI:** the existing React 19/React Router/Kumo/Tailwind mail interface, TanStack Query, Zustand, and TipTap.
- **Local runtime:** built SPA and Hono API on loopback, with production authentication fail-closed.
- **Mailboxes:** Stalwart owns canonical mail and attachment storage in a later phase. The app's integration journal will not be a second mailbox database.
- **Delivery:** Resend receiving API and authenticated SMTP relay, after account/domain and test-recipient approval.
- **Web access:** Cloudflare Access plus a named Cloudflare Tunnel to the local production origin, after the public-route gate.

No active R2, Durable Objects, Workers AI, or Cloudflare mail bindings are required by the intended local runtime. Kumo remains an ordinary frontend library.

AI chat, MCP, auto-drafting, automatic forwarding, and auto-replies are deferred. They must not appear as working features in the MVP.

## Safety and local development

- Fixture/demo messages are synthetic `.invalid` addresses, not real mailbox/provider evidence.
- Fixture preview belongs to the test harness and must never be exposed through a public tunnel or included in the production server bundle.
- Do not configure an authentication bypass for production. Cloudflare Tunnel alone is not authentication.
- Do not run the upstream Worker deploy setup, create an R2 bucket, or mix it with the local runtime. Legacy Worker files are inactive references pending their planned cleanup.
- Do not track credentials, private mailbox data, spool, backups, or local operator evidence in Git.
- No persistent service, live mailbox import/send, DNS change, tunnel, or repository publication is authorized by Phase 1.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
python3 scripts/stalwart-fixtures.py
```

The last command is the separately approved, isolated **real** Stalwart fixture test; ordinary `npm test` explicitly skips it. See [fixture setup](deploy/stalwart/README.md). `npm run preview:fixtures` serves only synthetic UI data on loopback. `NODE_ENV=production npm start` requires complete Access configuration and currently denies private requests because production identity/backend wiring is not finished. Do not tunnel fixture preview or interpret it as working mail.

## License

Apache-2.0. See [LICENSE](LICENSE). Existing Cloudflare copyright and license headers are retained in copied source.
