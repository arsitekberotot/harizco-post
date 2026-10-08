# Stalwart 0.16.25 JMAP capability evidence

## Result and scope

**Review fixes verified against real Stalwart.** The replacement regression was
first RED against a fresh store (**9 passed / 2 failed / 0 skipped**, exit 1),
then GREEN after the fix (**11 passed / 0 skipped**, exit 0), using
`python3 scripts/stalwart-fixtures.py`. Both owned processes were stopped.
Eight deterministic filesystem/evidence tests also pass after their recorded
RED run. This is not a production adapter, mailbox migration,
relay configuration, external send, or exactly-once-delivery certification.

The executable is pinned to the GitHub `v0.16.25` GNU x86-64 asset. Its archive
SHA-256 is `8ba9cc0ea2795121df5c1264af41e82353c5a3d6860161c4ab70817906d912d3`;
its extracted executable SHA-256 is
`ff97f92d2fbc09fa35fb0020b6b23d17f42279f85a783392d8a9b9c383ed755f`.
Release metadata, the existing archive, and executable bytes matched; the runner
checks both hashes and `--version` every time. Setup details and the repeatable
command are in [deploy/stalwart/README.md](../../deploy/stalwart/README.md).

## Verified boundary

All fixture state is under `/home/hanif/.local/share/harizco-post/test`, with fresh
per-run stores and generated private credentials. Every runner-created path is
lexically confined to the fixture or repository evidence tree. Directory
components (including ancestors above `test`) are opened with directory-relative
`O_NOFOLLOW`; files are opened no-follow, checked for regular type and a single
hard link before truncation/chmod. Runs and blob directories are created
exclusively, never reused. Symlink attempts at the parent namespace, `bin`,
`bin/stalwart`, `runs`, and config files are refused without changing the synthetic
outside sentinel. Those filesystem tests start no server or network namespace.
The earlier
`private/stalwart` wrapper/source/evidence were inspected **read-only**, not run
or adopted as proof. Its namespace explains why host `ss` does not show that
instance. Its previous prose about idempotency is not used here.

The final run used a different network namespace from the host and only `lo`:

```text
host:    net:[4026531840]
fixture: net:[4026532584]
recovery LISTEN 0 1024 *:18080 *:*       (only inside that namespace)
normal   LISTEN 0 1024 127.0.0.1:18081 0.0.0.0:*
```

No host port is bridged or published. Recovery's wildcard bind is confined by the
namespace; normal mode has one HTTP listener. No SMTP/IMAP listener or MTA relay
route is installed. Domain `allowRelaying` is false. The fixture account uses an
explicit replacement permission list; sending/submission-create and management
permissions are excluded. An authenticated `x:NetworkListener/get` from that
account returned `error / forbidden / You are not authorized to perform this
action`. The session's advertised capabilities do not override those permissions.

`STALWART_PUBLIC_URL` is explicitly set to the loopback fixture origin. The
pinned binary otherwise advertised an HTTPS URL using the machine hostname.
Tests reject off-origin session URLs and redirects instead of rewriting them.

RED normal PID **51556** and GREEN normal PID **52812** exited; both `/proc` entries
were absent on independent readback. The earlier PID
**4024188** remained present. No credentials appeared in the response/test/source
artifacts (checked against the generated client secrets).

## Capability matrix (actual responses/readback)

| Operation | Actual verified result |
| --- | --- |
| Session discovery | Authenticated `/jmap/session` returns primary mail account plus core/mail/blob/submission capabilities and loopback API/upload/download URLs. |
| `Mailbox/get` | Roles `drafts`, `inbox`, `junk`, `sent`, `trash` discovered, not hardcoded mailbox IDs. |
| HTTP MIME upload | Exact fixture bytes uploaded as `message/rfc822`; response size matches original; uploaded blob download matches original bytes. |
| `Email/import` | Correct creation-ID object with explicit `blobId`, `mailboxIds`, `keywords`, `receivedAt` creates Email objects for all three fixtures. |
| `Email/get` / canonical download | Subject, Message-ID, size, folders and body metadata read back; all original MIME downloads are byte-for-byte equal, including CRLF and original headers. No dedup header is inserted. |
| `Blob/lookup` | Temporary upload ID has `matchedIds: {}`; canonical Email blob has `matchedIds: {"Email": ["eaaaaab"]}`. The two IDs are not interchangeable. |
| Multipart attachment | Decoded `fixture.bin` downloaded exactly, 24 bytes with hash below. |
| HTML/CID inline image | `bodyStructure` identifies `cid:fixture-image`; HTML body retains its CID URL; PNG blob downloads exactly, 68 bytes. |
| `Mailbox/set` / `Email/set` | Creates a custom folder, moves Email membership, sets/removes `$seen` and `$flagged`; folder/flag/blob readback confirms results; folder destruction read back. |
| Draft creation/editing | Direct subject update is rejected. Replacement is three ordered phases: create only, verify new subject/body/flags/folder and old-ID readability, then separately destroy old and confirm absence. Rejected replacement creation preserves old metadata and exact canonical MIME. **A combined create/destroy request is not atomic or safe.** |
| Repeat import | Re-importing **the same uploaded blob** creates a second Email: `eaaaaab` vs `eaaaaah`, distinct canonical linked blob IDs, identical downloaded MIME. **No server deduplication.** |
| Real post-import/pre-journal client death | Separate Node process successfully uploads/imports, then exits 86 before writing receipt IDs. Parent recovers exactly one multipart candidate from paginated canonical MIME hash/size scanning, with no second import. |
| `Identity/get` | Fixture identity returned for the fixture address. |
| `EmailSubmission/query` / `get` | Query filter `emailIds: [emailId]` accepted; all submissions total 0; get of a missing fixture ID returns empty list and matching `notFound`. **No submission creation/send occurs.** |

### Deliberate unsupported/error probes

- `Email/import` missing the `blobId` property, even when the upload ID is used as
  the creation key: `notCreated.<key>.type = "invalidProperties"`, description
  **`Invalid blob id.`**, properties `["blobId"]`.
- Syntactically invalid `blobId`: same `invalidProperties` response.
- Well-formed but unavailable upload blob: `notCreated.absent.type =
  "blobNotFound"`, with a description identifying the unavailable blob. An
  earlier `blobNotFound` narration does not establish import is unsupported.
- `Email/query` filter `{contentHash: <sha256>}`: `error`, type
  **`unsupportedFilter`**, description **`contentHash`**. No supported native hash
  filter was found; the spike uses downloads, not fabricated indexed lookup.
- Direct `Email/set` draft `subject` mutation: `notUpdated.<draftId>.type =
  **`invalidProperties`**. Content fields are immutable; replacement is the
  verified editing primitive, not in-place mutation.
- Replacement create with **`mailboxIds: {}`**: `notCreated.edited.type =
  **`invalidProperties`**, description **`Message has to belong to at least one
  mailbox.`**, properties **`["mailboxIds"]`**. This is a real pinned-server
  rejection, not an assumed rejection of an unknown/ignored property.
- Successful optional `notCreated` / `notDestroyed` fields are **omitted** by this
  binary rather than always sent as explicit null. Tests accept omitted/null
  errors but also require the exact created/updated/destroyed IDs and readback.

### Replacement safety regression (actual RED → GREEN)

The RED run `ec856a593cb93ca2` used the former combined `Email/set` operation.
Its response contained both `notCreated.edited` with the error above **and**
`destroyed: ["qaaaaae"]`. A following `Email/get` returned that old ID in
`notFound`. The successful-replacement ordering test also failed because the old
ID was already destroyed when replacement verification ran.

The GREEN run `4c3e16bb8695ce75` sends only `create` first. On rejection the old
ID `qaaaaae` remains readable, metadata matches, and its 329-byte canonical MIME
matches the bytes downloaded before the rejected request. On success the new ID
`yaaaaag` is read back while `uaaaaaf` still exists; only then does a separate
destroy-only call remove `uaaaaaf`, with exact destroyed-ID and absence readback.
The ordered response markers are `draft-rejection-preservation`,
`draft-replacement-verified-before-destroy`, and
`draft-original-destroyed-after-verification`. There is no destructive combined
create/destroy request in the fixed test primitive. This remains spike code, not
a production adapter or a transaction across systems.

## Fixture identities and exact bytes

These synthetic `.test` messages are checked in; they contain no real mail.

| Fixture / decoded part | Bytes | SHA-256 |
| --- | ---: | --- |
| `plain.eml` | 307 | `0576b9ad07641a5ae5223ac8a4572c77912eca3e8510744aadd09f5919600774` |
| `multipart.eml` | 599 | `30be9ee11ac28a56e21e925bee6e4e296861a531c607e7076a629c35081c72d5` |
| `inline-image.eml` | 712 | `58a8500b3639202b0cb9eacdd0adfab9a97c0ad21c67d63e792cb75370585e4b` |
| Multipart decoded attachment | 24 | `c2f433eba382842c4847d5283da38497b6c61f116884f080ffa843c7533f078d` |
| Inline decoded PNG | 68 | `3bb51153e96fd203ab4677bf9d113105e3eaa3cdcc1631a27647f13e8b4bbaa0` |

Example final plain identity (opaque IDs, **do not parse/reconstruct them**):

```json
{
  "emailId": "eaaaaab",
  "uploadBlobId": "edqqc1bcl70w0rivmr9fcwfpkzrahhg3ci7mimyz3gtuofmysbtkaapgs1nnmbq",
  "canonicalBlobId": "cdqqc1bcl70w0rivmr9fcwfpkzrahhg3ci7mimyz3gtuofmysbtkaaiaae",
  "size": 307,
  "sha256": "0576b9ad07641a5ae5223ac8a4572c77912eca3e8510744aadd09f5919600774"
}
```

## Crash recovery proof and limits

The receipt journal on disk was written first with original hash/length,
`state: "spooled"`, and both identities null. The crash helper received only
private config/fixture paths and the discovered inbox ID. After successful real
`Email/import`, it deliberately terminated with exit 86, without recording the
upload/Email ID in that journal or returning them to the parent.

The surviving test then:

1. Read back the durable receipt and confirmed both IDs were still null.
2. Enumerated `Email/query` in **two-item pages**, downloaded each Email/get
   canonical blob, and matched SHA-256 **and byte length** to original MIME.
3. Found exactly one multipart candidate, Email **`baaaaaai`**, downloaded it again
   and checked its original hash.
4. Persisted the recovered Email/canonical blob identity and read back the
   verified receipt. Total Emails remained **6 before / 6 after** reconciliation.
   There was no new upload/import during recovery.
5. Found **two** plain-MIME candidates and held that ambiguity instead of taking
   the first Message-ID/content match.

This proves the required **primitive** for this small isolated dataset. It does
not implement or certify the existing production importer/reconciler. A real
importer needs a durable pre-side-effect receipt intent, per-account import
serialization/ownership, bounded/cursor-safe scanning or a proven index, exact
canonical byte verification, and an explicit ambiguity hold. Identical legitimate
messages for different provider receipt IDs cannot be assigned by MIME equality
alone. SQLite uniqueness does not atomically commit with Stalwart. Neither an
upload blob ID nor a Message-ID guarantees cross-system exactly-once import.

The fixture probe intentionally permits only submission **reads**. Empty lookup
proves that the method/filter works, not populated submission lookup, queue
acceptance, outbound idempotency, relay headers, provider acceptance, or external
delivery. Those remain separate approved tests; no mail was sent here.

## Execution records and regression status

Ignored `.hermes/evidence/task5/` contains the new review evidence:

- `review-fs-and-evidence-red.txt`: eight tests run before the filesystem/evidence
  fix; nine failed assertions (config filenames are subtests). The failures show
  missing refusal and shared evidence rather than a live-server prerequisite.
- `review-fs-green.txt`: **8 passed**, no server startup. Run with
  `python3 -m unittest discover -s tests/integration -p 'test_stalwart_fixtures_fs.py' -v`.
- `runs/ec856a593cb93ca2/`: actual replacement RED run, **9 passed / 2 failed**,
  exit 1, 78 response entries.
- `runs/4c3e16bb8695ce75/`: actual fixed GREEN run, **11 passed / 0 skipped**,
  exit 0, 86 response entries.
- Each run retains `runner.log`, `responses.jsonl`, `pin.json`,
  `recovery-isolation.json`, `isolation.json`, `teardown.json`, and `manifest.json`.
  The manifest ties the run ID/private store to source and artifact SHA-256s,
  timestamps, command and exit status. Both runs' artifact hashes were verified;
  all GREEN source hashes match the fixed files. RED's test-source hash differs
  as expected after the fix. No shared response/isolation files are overwritten.
- `review-verification.json` and `review-response-order-check.json`: independent
  artifact/source hash, explicit response-order, plain/encoded secret-absence,
  process-absence and prior-PID-presence checks.
- `review-full-suite.txt`: current workspace regression run, exit **0**,
  **196 passed / 11 explicit fixture skips**. The real suite is separately GREEN
  above; ordinary opt-in skips are not presented as real-service evidence.

Older shared evidence/logs are retained as historical records; they are not
relabelled or combined with the new per-run manifests.

Focused TypeScript checking of `stalwart-import.test.ts`, Node syntax checking of
`stalwart-crash.mjs`, Python compilation, and `git diff --check` succeeded. No
commits or pushes were made, and this review-fix lane changed no UI/server adapter
files; unrelated concurrent workspace edits are not attributed to this lane.
This isolation assumes a trusted local owner: no-follow runner writes and fresh
private directories are not a sandbox against a hostile same-UID process
continually replacing paths while Stalwart or Node operates on its private store.

## Matching pinned source references

- [Release API / asset digest](https://api.github.com/repos/stalwartlabs/stalwart/releases/tags/v0.16.25)
- [Current JMAP documentation](https://stalw.art/docs/http/jmap/)
- [0.16.25 registry schema](https://github.com/stalwartlabs/stalwart/blob/v0.16.25/crates/registry/src/schema/structs.rs)
- [0.16.25 keyed registry List](https://github.com/stalwartlabs/stalwart/blob/v0.16.25/crates/registry/src/types/list.rs)
- [0.16.25 recovery/public URL environment settings](https://github.com/stalwartlabs/stalwart/blob/v0.16.25/crates/store/src/registry/local.rs)

The live fixture responses, rather than older wrapper comments or mock tests,
are the evidence for each capability above.
