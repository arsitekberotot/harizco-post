# Immutable legacy integration-journal fixture

`0001-fbd509c.sql` is byte-identical to `server/db/migrations/0001_integration.sql` at implementation baseline `fbd509c4a4e209f650aa61649b8c89f51498a617`.

SHA-256: `a6df8a625523d8a6a61589e607d3387f77080fb9d0a4ab020d75a2cbd64de31c` (parent compared the snapshot's bytes with `git show` output).

Historical behavior, not a recommendation: its `mailboxes.enabled` default is `1`. Additive migration deliberately retains the legacy DDL and row values rather than rebuilding that table or silently changing existing activation. Tests assert that behavior, assert new registry-provisioned rows explicitly insert `enabled=0`, and exclude unbound legacy records from sendable identities. Current fresh-store migration uses default `0`.

Do not replace this fixture with current migration SQL: that would erase the legacy condition the upgrade test must exercise. The legacy exactly-once comment is retained only because this is an immutable historical snapshot; a journal uniqueness constraint does not prove cross-system JMAP import uniqueness.
