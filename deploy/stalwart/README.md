# Pinned Stalwart fixture service (Task 5)

**Verified fixture-only setup, not a production mailbox deployment.** The real
Stalwart JMAP primitives are exercised by `scripts/stalwart-fixtures.py`. No SMTP
relay, Resend credential, real mail, public listener, DNS change, root change,
persistent service, or delivery verification is configured here.

The former unpinned TOML relay example has been removed: Stalwart **0.16.25** uses
a JSON data-store entrypoint and its management JMAP API for the operational
configuration used by this test. Do not apply older TOML examples to this release.

## Pin and provenance

| Item | Pinned value |
| --- | --- |
| Release | `v0.16.25` |
| Asset | `stalwart-x86_64-unknown-linux-gnu.tar.gz` |
| Archive SHA-256 | `8ba9cc0ea2795121df5c1264af41e82353c5a3d6860161c4ab70817906d912d3` |
| Extracted `stalwart` SHA-256 | `ff97f92d2fbc09fa35fb0020b6b23d17f42279f85a783392d8a9b9c383ed755f` |

The archive digest was checked against the asset's `digest` in the
[GitHub release API](https://api.github.com/repos/stalwartlabs/stalwart/releases/tags/v0.16.25).
The existing archive at `private/stalwart/downloads/stalwart.tar.gz` matched; the
existing executable and the executable inside that archive matched each other.
The runner always verifies both digests and `--version` before starting. It
extracts a separate copy and never operates the earlier private instance.

## Run the actual integration suite

Prerequisites: Linux x86-64 GNU userspace, Python 3, Node 22, installed project npm
dependencies, `unshare`, `ip`, `ss`, and permitted **unprivileged user/network
namespaces**. No `sudo` is used. Run one fixture runner at a time, from the project:

```sh
python3 scripts/stalwart-fixtures.py
```

By default this reuses the verified local archive; it does not download or track
`latest`. If the archive is elsewhere, supply its exact path:

```sh
STALWART_ARCHIVE=/absolute/path/to/stalwart-x86_64-unknown-linux-gnu.tar.gz \
  python3 scripts/stalwart-fixtures.py
```

If it is unavailable, retrieve the pinned asset separately from
[the pinned release](https://github.com/stalwartlabs/stalwart/releases/tag/v0.16.25)
and verify the digest above. A checksum mismatch fails closed. Namespace denial,
startup failure, unexpected interfaces/listeners/routes, readback mismatch, or a
failed assertion yields a nonzero exit. Do **not** bypass a namespace failure with
host/public binds, privileged commands, or a production service.

Plain `npm test` deliberately **skips** this opt-in suite, rather than contacting
an operator's mailbox or substituting a mock. Its skipped tests are not Stalwart
evidence. The runner invokes the same suite with a private generated client
config, yielding **11 real integration tests with no skips** on the verified
review-fix run. The filesystem regression suite is independent of a live service:

```sh
python3 -m unittest discover -s tests/integration -p 'test_stalwart_fixtures_fs.py' -v
```

It currently runs eight deterministic tests, including synthetic outside-sentinel
checks and per-run evidence retention. It never starts Stalwart or a namespace.

## Isolation and lifecycle

- Fixed state root: `/home/hanif/.local/share/harizco-post/test` on this host
  (`Path.home()/.local/share/harizco-post/test` on another fixture host).
- Separate verified executable: `test/bin/stalwart`.
- All runner writes use lexical containment plus directory-relative no-follow
  opens for **every** path component, including parent namespace directories.
  Existing symlinks at `bin`, `bin/stalwart`, `runs`, runtime files, or evidence
  components fail closed. Regular files with multiple hard links are rejected
  before truncation or chmod; checks are on the opened inode, not only `is_symlink`.
- Each run gets a **new** `test/runs/<random>/` directory with SQLite, blob files,
  private runtime logs, generated client configuration, and the crash receipt.
  No existing store is reset or deleted. Files are private (`0600`); new
  directories use `0700`. Test credentials are generated, not embedded in source,
  passed on the command line, or printed.
  The run and its blob directory are created exclusively; pre-existing run
  paths are never adopted. Stalwart/Node operate inside this fresh private tree.
- The runner puts **both server and tests** in one new user/network namespace;
  netlink reports only `lo`. User-namespace UID 0 is not host root. There is no
  veth, network bridge, namespace port forward, or host listener.
- Recovery temporarily listens on port `18080` inside that namespace. Its
  wildcard bind is why the namespace is mandatory even for bootstrap.
- The sole configured normal listener is `127.0.0.1:18081`, HTTP/JMAP only. The
  runner checks the actual `ss` listeners before running tests. HTTP is acceptable
  only for this inaccessible, loopback-only fixture; it is not production TLS.
- `STALWART_PUBLIC_URL=http://127.0.0.1:18081` makes discovered session URLs match
  the fixture origin. Without this override the pinned binary advertised an
  HTTPS URL derived from the host name. Tests refuse off-origin URLs/redirects;
  they do not silently rewrite a production session.
- The fixture domain is `harizco.test`, relaying and SCIM provisioning disabled,
  with zero configured outbound MTA routes. The account has a `User` role and an
  explicit replacement permission set limited to fixture mailbox/email/blob
  operations and identity/submission **reads**. Neither `emailSend` nor
  `jmapEmailSubmissionCreate` nor management permissions are granted.
- Every setup write is checked by management readback. The normal account's
  management access is also probed and returns `forbidden`.
- The test helper forbids `EmailSubmission/set` entirely. No delivery, queue
  acceptance, populated submission reconciliation, SMTP, or external send is
  claimed from a capability advertisement or an empty lookup.
- Test Emails/folders are removed with readback. The runner waits for its own
  Stalwart process to stop in `finally`, including on failed assertions. The old
  `private/stalwart` process and data/config are not modified.

No enabled service/unit is created. A finished run leaves private fixture data
for diagnosis, **not a running fixture server**. The namespace disappears after
its processes exit. Old fixture runs can be removed manually when no runner is
active; no automatic deletion of operator data is performed.
This assumes a trusted local owner, not a hostile same-UID process replacing
private paths concurrently during service/test execution.

## Evidence and integration implications

The runner saves ignored `.hermes/evidence/task5/runs/<runId>/` records, using the
same ID as the private fixture store. Prior run evidence is not overwritten:

- `manifest.json`: run ID, command, timestamps, exit status, exact source SHA-256s,
  and artifact SHA-256s tying the following records to this execution;
- `runner.log`: actual captured test output and teardown output;
- `pin.json`: executable and release pin;
- `recovery-isolation.json`, `isolation.json`: namespace, interfaces, listeners,
  restricted permissions, private run path;
- `responses.jsonl`: actual JMAP responses and byte/hash reconciliation evidence,
  never request Authorization headers or passwords;
- `teardown.json`: stopped process, exact PID absence and private run path.

The review regression run `ec856a593cb93ca2` was intentionally RED (9 passed,
2 failed, exit 1). The fixed fresh-store run `4c3e16bb8695ce75` was GREEN
(11 passed, 0 skipped, exit 0); both owned processes exited. No historical shared
log is relabelled as a new run.

See [the capability report](../../docs/spikes/stalwart-jmap.md) for supported and
unsupported operations, exact fixture MIME hashes, crash evidence, and the
repeat-import/identity caveats. The production adapter is intentionally not
implemented by this spike. In particular, it must not equate a temporary upload
blob with the canonical Email blob, assume import deduplication, or edit draft
content in place. Draft replacement must **create → verify readable replacement
→ separately destroy old**. The real regression uses rejected `mailboxIds: {}`
and confirms old metadata and exact MIME survive. A combined create/destroy
`Email/set` is not atomic: the pinned server destroyed old even when it rejected
the replacement in the RED reproduction. No production adapter is advanced here.

## Relay remains unconfigured

Future outbound transport must be separately approved and verified for this
pinned configuration model, TLS authentication, sender authorization, receipt
identity, and ambiguous-acceptance recovery. Neither this document nor mocked
submission tests prove a Stalwart-to-Resend relay. Do not claim exactly-once
external delivery or add a direct-MX fallback based on this fixture result.
