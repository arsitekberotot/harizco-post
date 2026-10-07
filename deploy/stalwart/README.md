# Stalwart-to-Resend relay configuration (Task 15)

Harizco Post keeps Stalwart as the canonical local mail store and uses an
**authenticated TLS SMTP relay to Resend** only for outbound submission. There is
no direct-MX fallback and no unauthenticated relay path.

> Status: this document describes the configuration to apply once the Phase 2
> (Stalwart install) and Phase 4 (live outbound relay) gates are approved. No
> live relay is configured by the repository. The recovery rules it implements
> are proven against a mocked transport in
> `tests/integration/submission-recovery.test.ts`.

## Required relay properties

1. **Authenticated only.** Outbound uses Stalwart's authenticated submission
   path. Unauthenticated relay and direct-MX delivery are disabled:
   ```toml
   [queue.outbound]
   # no direct MX; only the configured authenticated relay
   route = "resend-relay"
   ```
2. **TLS with certificate verification.** Relay to `smtp.resend.com` with a
   valid certificate on **port 465 (implicit TLS)** — or a verified
   **required-STARTTLS** configuration on 587. Never `tls.none`, never
   `verify = false`.
3. **Secrets from private configuration only.** The Resend API/SMTP credential
   is read from an environment variable or a root-owned file outside the repo
   (e.g. `/etc/harizco-post/resend.env`, mode `0600`). It is never committed and
   never printed. Log redaction covers `*_token`, `*_secret`, `*_password`,
   `*_key` (see `server/config.ts` `redactForLog`).
4. **No open relay.** Submission requires authentication; the relay account may
   only send as an **owned domain**. The server enforces this before the queue
   (`server/mail/validation.ts`): a From that is not the selected mailbox on an
   owned domain is rejected.
5. **Same-domain delivery defined explicitly.** A message to an address on an
   owned domain is still submitted through the relay (so it appears in the
   recipient's mailbox and the logs consistently) rather than short-circuited to
   local delivery, unless a specific local-delivery rule is approved.

## Idempotency across retries

Every submission attempt carries the **same** `Idempotency-Key` header, whose
value is the durable `submission_intents.request_id` (a stable hash of the
payload). This is what lets a retry after an ambiguous failure be de-duplicated
by the provider instead of delivering twice. See `server/mail/submissions.ts`:

- `createIntent()` writes the intent + key before any side effect;
- `submitWithIdempotency()` reuses the key on the single attempt;
- an ambiguous result becomes `unknown` and is **held**, never auto-retried;
- `reconcile()` resolves `unknown` from the provider id without a new send.

## Verification (after the gates)

- `npm test -- tests/integration/submission-recovery.test.ts` (mock transport;
  runs anywhere, no live relay).
- Live relay test: **requires separate approval of an external recipient and the
  Resend account.** Do not run without it. Verify the exact headers the relay
  emits (Message-ID, In-Reply-To, References, Idempotency-Key) and that a forced
  retry does not deliver twice.
