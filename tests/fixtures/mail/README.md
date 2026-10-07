# Synthetic mail fixtures

**Label:** `SYNTHETIC TEST FIXTURE — not provider evidence`

These files define in-memory demo mailbox/thread data for Phase 1 Vitest and
Playwright contracts. Addresses use the reserved `.invalid` TLD so they cannot
resolve on the public Internet.

## What this is

- Test/demo shapes compatible with `app/types/index.ts` and the UI REST client.
- Read/list preview data for `tests/helpers/fixture-preview.ts` only.

## What this is not

- Not Resend, Stalwart, Cloudflare, or any live-provider evidence.
- Not a disk mailbox database, spool, or outgoing mail path.
- Not bundled into the production Node server (`dist/server/index.js`).
- Not a production authentication bypass.

Real mailbox state begins only after the separately approved Phase 2 gate.
