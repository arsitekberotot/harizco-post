# Task 6 — integration journal foundation

Status: foundation **SPEC PASS** (`deleg_9c187574`) and fresh quality **APPROVED** (`deleg_2bd422e4`). All five findings from initial quality `deleg_c65ce7a2` are closed after controller-led TDD.

Aggregate integration gate: **now GREEN and parent-verified.** The earlier aggregate run was **377 passed / 3 failed / 11 skipped** while Task 19 authentication source was mid-flight; those three failures (fixture-mode rejection wording, in-root `.js`→source-map symlink exposure, and the import-time global `Response` shim breaking a Resend test at `tests/server/resend-receiving.test.ts:177`) were resolved by the Task 19 owner `deleg_a98d7707`, and the parent then independently re-ran the full repository suite against the current tree: **388 passed / 11 intentional real-Stalwart skips**, exit 0, with `npm run typecheck`, `npm run build`, `git diff --check` and the rebuilt bundled-entrypoint smoke also exit 0 (logs `.hermes/evidence/task19/parent-integrated-{suite,types,build,smoke}.log`).

This still does **not** certify full browser/JMAP integration or production importer/submission caller integration. The web read path is now wired (parent-added `mailbox` config binding + `createProductionBackend` → `JmapMailBackend`; suite **398 passed / 11 skips**), but the production importer/submission callers remain synthetic-only and unverified.

## Actual execution

The Hermes implementation lane `deleg_076816ec` failed with HTTP 429 before any edits. No delegated Task 6 implementation landed. Work below is controller-led TDD on in-memory or synthetic scratch databases only.

- Native driver exercised: Node `v22.22.2`, `better-sqlite3` `13.0.3`; exact dependency and root lock pin are now `13.0.3`.
- Registry regression cycle: 5 expected RED → 20 GREEN; follow-up identity/settings regressions contributed 4 more expected RED.
- Journal regression cycle: 11 confirmed expected RED → 11 GREEN; follow-up malformed-readback regression was RED and repaired; additive-migration rollback regression passed.
- Pre-review focused command: **40 passed** (13 journal + 27 registry), after 3 activation-input RED regressions were repaired.
- Pre-review full suite: **229 passed / 11 deliberate real-service skips**; typecheck, client/server/worker build, `git diff --check` passed. Historical evidence: `.hermes/evidence/task6/{activation-red,activation-green,final-full-suite,final-typecheck,final-build}.log`.
- Independent spec review `deleg_9c187574`: **PASS for foundation APIs only**, with fresh native-driver and esbuild `write:false`/`:memory:` probes. Initial quality `deleg_c65ce7a2` requested changes: binding read/write race, truthy setup activation, cross-connection setup transaction, competing provisioning and an incorrectly current legacy fixture. Reviewer reproductions were not executed; parent subsequently exercised them through the existing Vitest harness.
- Quality repair RED: **8 expected failures**, including a deterministic stale-read interleaving across two real SQLite connections, same-address competing provision, five malformed enable values, and wrong-connection partial setup. GREEN: **48 focused passed** (15 journal + 33 registry). Evidence `.hermes/evidence/task6/quality-revision-{red,green}.log`.
- Independent fresh quality review `deleg_2bd422e4`: **APPROVED — foundation only**; all five prior findings closed, no new Critical/Important/Minor findings. Reviewer executed the 48 focused tests and scoped diff-check, verified the immutable fixture against Git bytes/blob IDs, and reviewed migration/lease/settings/unlink boundaries. No files edited, production activity or withdrawn harness execution. Reviewer did not rerun the aggregate suite/typecheck/build; their approval does not replace the parent integration gate.
- Latest aggregate gate while Task 19 source was still being implemented: **377 passed / 3 failed / 11 intentional skips**, not a green overall result. Failures were in the in-flight Access/production-handler tests and a Resend Response-method regression; the Task 19 owner was notified. Typecheck, client/server/worker build and diff-check passed. Evidence `.hermes/evidence/task6/quality-revision-{full-suite,typecheck,build}.log`. Aggregate gate must be rerun after that lane finishes.
- Independently bundled `server/db/index.ts` using esbuild's SQL text loader, then opened the actual bundle with the native driver: `schemaVersion=2`, settings table available, foreign keys enabled. No runtime dependence on a checkout SQL path.

Evidence: `.hermes/evidence/task6/{registry-red,registry-green,journal-red-confirmed,journal-green,review-red,review-green,parent-full-suite,parent-typecheck,parent-build,worker-build}.log` and `journal-bundle.mjs`.

## Implemented boundary

- Canonical SQL migration files, bundled through `server/db/schema.ts`; atomic pending migration batch with `PRAGMA user_version`, no repeat application, future-version rejection before journal changes, closed connection on failure.
- Synthetic legacy identities, jobs, settings survive upgrade and reopening. The upgrade test now uses a byte-identical snapshot of actual baseline `fbd509c4a4e209f650aa61649b8c89f51498a617` SQL, not the modified current migration. Snapshot SHA-256 `a6df8a625523d8a6a61589e607d3387f77080fb9d0a4ab020d75a2cbd64de31c` independently matched Git bytes. Additive migration deliberately retains legacy table default `enabled=1` and existing rows; registry inserts explicitly use `0`, and unbound legacy identities are excluded from sendable lists. Fresh-store DDL default is `0`. No legacy table rebuild or hidden activation rewrite is claimed.
- Failed additive migration rolls back the version and schema changes; tests close their own handles and remove only their own synthetic scratch directories.
- Address/identity/binding controls are validated; failed operator setup is atomic and rejects a registry tied to another connection. Defined non-boolean activation is refused before mutation; only literal `true` activates. Canonical binding updates use a null/equal SQL CAS, so stale reads cannot silently remap a competing winner, including an enabled mailbox. Address-only conflict handling returns the competing provisioned identity rather than swallowing unrelated constraint errors.
- Disable/unlink preserves mappings, receipts/intents and canonical data. Browser destructive deletion remains absent.
- Partial settings updates retain prior validated values; unknown keys are dropped; corrupt stored JSON fails closed with a generic error. Receiving page size is bounded to the actual provider maximum of 100.
- Both import and submission rows support owner + random per-claim token + expiry. Atomic claims are exclusive across connections; token and live expected-state CAS guard transitions/releases, including same-owner ABA. TTL is bounded to 5 minutes.
- Named transition edges require canonical identifiers for verified import and a provider identifier for accepted submission. Those strings are metadata supplied after readback, not proof produced by the journal.
- Expired `submitted` claims become held `unknown`, not resendable. Accepted/verified/quarantined/unknown rows are not automatically reclaimed.

## Explicit remaining integration work

- Task 7/8 must wire the registry activation-only contract through actual mailbox/account-scoped JMAP routes and prove real local UI behavior. A configured account ID does not by itself prove a live account.
- Existing import/submission callers still contain legacy direct SQL updates and are not yet migrated to the new lease/CAS primitives. Task 11/14 must do that before production use.
- Held reconciliation requires authoritative account-scoped JMAP/provider evidence and an explicit recovery path; this primitive slice does not fabricate it.
- Journal uniqueness is not exactly-once JMAP import or external delivery proof. Hash+length readback/recovery and external submission acceptance still require their respective tasks.
- No existing user database was opened or migrated; no real accounts, sends, listeners, DNS, authentication policy, persistent service or backup destination were changed.

Production migration rollback is NOT a blind schema downgrade: keep an independent verified backup and use an approved compatibility/restore procedure. Current verification ran synthetic copies only.
