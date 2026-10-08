# Task 16 — pure threading helper evidence (not integration approval)

Status: helper regressions repaired; **Task 16 remains incomplete**.

## Exercised locally

`npm test -- tests/contracts/reply-forward.test.ts`:
- RED: 4 expected failures / 14 collected tests (`.hermes/evidence/threading-helper-red.log`).
- GREEN: 14 passed (`.hermes/evidence/threading-helper-green.log`).
- Scoped whitespace check passed.

Observed regressions repaired:
- A missing RFC Message-ID no longer falls back to a local opaque Email/id. Missing headers are omitted instead of invented; local thread IDs stay local.
- Supported identifiers are validated before header assembly. CRLF/NUL, whitespace, malformed identifiers and multiple concatenated IDs fail with a generic error; surrounding brackets normalize once and References deduplicate after normalization.
- Reply-all uses Reply-To when present, falls back to From otherwise, and removes the selected mailbox address before To/Cc deduplication. It does not read Bcc.
- Existing helper tests retain ordinary replies and fresh unthreaded forwards.

## Deliberate limits

The Message-ID validator supports modern dot-atom IDs and domain literals. Obsolete quoted/CFWS identifier forms are rejected rather than rewritten. This is not a full RFC parser or an external threading certification.

Code inspection found no active production callers of `buildReferencesChain`, `buildThreadingHeaders`, or `computeReplyAll` outside this module and its contract tests. The retained compose hook still has separate reply logic and the server has no reply/forward route.

## Required before closing Task 16

- Resolve original local message references from authoritative mailbox/account-scoped Stalwart metadata.
- Wire replies and forwards through server routes and validated durable submission intents.
- Correct retained composer Reply-To/draft-mode handling; a forward draft must not acquire reply headers or original conversation identity.
- Preserve only explicitly selected, owned forward attachments.
- Verify actual UI/local Stalwart behavior and separately authorized external header truth.

No queue/provider mutation, external send, account configuration or runtime service change was performed by these helper tests.
