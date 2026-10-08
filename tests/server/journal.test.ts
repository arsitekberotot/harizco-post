// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in LICENSE.
// Task 6: synthetic SQLite migrations and guarded integration leases only.
import { afterEach, describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as journal from "../../server/db/index";
import { MailboxRegistry, RegistryError } from "../../server/mailboxes/registry";

const connections: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const db of connections.splice(0)) if (db.open) db.close();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true });
});
function open(path = ":memory:") {
	const db = journal.openJournal(path);
	connections.push(db);
	return db;
}
function scratchPath() {
	const dir = mkdtempSync(join(tmpdir(), "harizco-journal-test-"));
	directories.push(dir);
	return join(dir, "synthetic.sqlite");
}
function seed(db: Database.Database) {
	new MailboxRegistry(db).provision({ id: "mb1", address: "fixture@example.test", jmapAccountId: "a1" });
	const at = "2026-01-01T00:00:00.000Z";
	db.prepare("INSERT INTO import_jobs(provider,provider_receipt_id,target_mailbox_id,state,created_at,updated_at) VALUES ('fixture','r1','mb1','pending',?,?)").run(at, at);
	db.prepare("INSERT INTO submission_intents(request_id,mailbox_id,payload_hash,state,created_at,updated_at) VALUES ('req1','mb1','hash1','intent',?,?)").run(at, at);
}

const NOW = Date.parse("2026-01-01T01:00:00.000Z");
describe("registry cross-connection interleavings", () => {
	test("a stale unbound read cannot overwrite another connection's enabled account", () => {
		const path = scratchPath();
		const a = open(path), b = open(path);
		const first = new MailboxRegistry(a), winner = new MailboxRegistry(b);
		first.provision({ id: "mb1", address: "fixture@example.test" });
		const get = first.getById.bind(first);
		// Scheduling hook only: the snapshot and both competing writes use real
		// SQLite connections. No database responses or mutations are fabricated.
		vi.spyOn(first, "getById").mockImplementationOnce(id => {
			const snapshot = get(id);
			winner.bindAccount(id, "winning-account");
			winner.setEnabled(id, true);
			return snapshot;
		});
		expect(() => first.bindAccount("mb1", "stale-account")).toThrow(RegistryError);
		expect(winner.getById("mb1")).toMatchObject({ enabled: 1, jmap_account_id: "winning-account" });
	});
	test("a competing address provision returns the winning identity rather than a uniqueness error", () => {
		const path = scratchPath();
		const a = open(path), b = open(path);
		const first = new MailboxRegistry(a), other = new MailboxRegistry(b);
		const prepare = a.prepare.bind(a);
		let interleaved = false;
		vi.spyOn(a, "prepare").mockImplementation(sql => {
			const statement = prepare(sql);
			if (!interleaved && sql === "SELECT * FROM mailboxes WHERE address = ?") {
				const get = statement.get.bind(statement);
				vi.spyOn(statement, "get").mockImplementationOnce((...values: unknown[]) => {
					const snapshot = get(...values);
					interleaved = true;
					other.provision({ id: "winner", address: "fixture@example.test" });
					return snapshot;
				});
			}
			return statement;
		});
		expect(first.provision({ id: "stale", address: "fixture@example.test" }).id).toBe("winner");
		expect(interleaved).toBe(true);
		expect(first.listAll()).toHaveLength(1);
	});
});
describe("versioned journal migrations", () => {
	test("a failed additive migration rolls back the entire pending batch and closes its connection", () => {
		const path = scratchPath();
		const legacy = new Database(path);
		legacy.exec(readFileSync(new URL("../../server/db/migrations/0001_integration.sql", import.meta.url), "utf8"));
		seed(legacy);
		legacy.exec("ALTER TABLE import_jobs ADD COLUMN lease_token TEXT");
		legacy.close();
		expect(() => journal.openJournal(path)).toThrow();
		const check = new Database(path); connections.push(check);
		expect(check.pragma("user_version", { simple: true })).toBe(0);
		expect(check.prepare("SELECT COUNT(*) n FROM import_jobs").get()).toEqual({ n: 1 });
		expect((check.pragma("table_info(submission_intents)") as { name: string }[]).some(c => c.name === "lease_owner")).toBe(false);
		check.exec("BEGIN IMMEDIATE; ROLLBACK;");
	});
	test("fresh stores apply all migrations including app settings and lease columns", () => {
		const db = open();
		expect(db.pragma("user_version", { simple: true })).toBe(2);
		expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'").get()).toBeTruthy();
		expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
		db.prepare("INSERT INTO mailboxes(id,address,created_at) VALUES ('raw','raw@example.test','fixture')").run();
		expect(db.prepare("SELECT enabled FROM mailboxes WHERE id='raw'").get()).toEqual({ enabled: 0 });
		const columns = db.pragma("table_info(submission_intents)") as { name: string }[];
		expect(columns.map(c => c.name)).toEqual(expect.arrayContaining(["lease_owner", "lease_token", "lease_expires_at"]));
	});
	test("an unversioned synthetic legacy journal upgrades once without losing identities or jobs", () => {
		const path = scratchPath();
		const legacy = new Database(path);
		// Byte-identical immutable DDL from fbd509c4a4e209f650aa61649b8c89f51498a617.
		// Unlike current fresh-store DDL, its mailbox default is enabled=1.
		legacy.exec(readFileSync(new URL("../fixtures/journal/0001-fbd509c.sql", import.meta.url), "utf8"));
		legacy.prepare("INSERT INTO mailboxes(id,address,created_at) VALUES ('old-default','old@example.test','fixture')").run();
		expect(legacy.prepare("SELECT enabled FROM mailboxes WHERE id='old-default'").get()).toEqual({ enabled: 1 });
		seed(legacy);
		legacy.prepare("INSERT INTO app_settings(key,value) VALUES ('existing','{\"keep\":true}')").run();
		legacy.close();
		const first = open(path);
		expect(first.pragma("user_version", { simple: true })).toBe(2);
		expect(first.prepare("SELECT COUNT(*) n FROM import_jobs").get()).toEqual({ n: 1 });
		expect(first.prepare("SELECT value FROM app_settings WHERE key='existing'").get()).toEqual({ value: '{"keep":true}' });
		// Additive migration deliberately preserves the legacy DDL/row, not a
		// destructive table rebuild. Registry inserts remain explicitly disabled.
		expect((first.pragma("table_info(mailboxes)") as { name: string; dflt_value: string }[]).find(c => c.name === "enabled")?.dflt_value).toBe("1");
		expect(first.prepare("SELECT enabled FROM mailboxes WHERE id='old-default'").get()).toEqual({ enabled: 1 });
		const migrated = new MailboxRegistry(first);
		expect(migrated.provision({ id: "new-disabled", address: "new@example.test", jmapAccountId: "a2" }).enabled).toBe(0);
		expect(migrated.listEnabled()).toEqual([]);
		first.close();
		const second = open(path);
		expect(second.pragma("user_version", { simple: true })).toBe(2);
		expect(second.prepare("SELECT COUNT(*) n FROM submission_intents").get()).toEqual({ n: 1 });
	});
	test("future schema versions are rejected without downgrading or writing", () => {
		const path = scratchPath();
		const future = new Database(path);
		future.pragma("user_version = 999");
		future.close();
		expect(() => journal.openJournal(path)).toThrow(/newer|unsupported/i);
		const check = new Database(path);
		connections.push(check);
		expect(check.pragma("user_version", { simple: true })).toBe(999);
		expect(check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get()).toEqual({ n: 0 });
	});
});

describe("lease ownership and state transitions", () => {
	test("malformed previously recorded readback ids cannot satisfy verification", () => {
		const db = open(); seed(db);
		db.prepare("UPDATE import_jobs SET state='imported',stalwart_email_id=' ',stalwart_blob_id=' ' WHERE id=1").run();
		const lease = journal.claimJob(db, "import_jobs", 1, "worker", 1000, NOW)!;
		expect(() => journal.transitionJob(db, lease, "verified", {}, NOW)).toThrow(/readback|canonical/i);
	});
	test("only one connection can claim a pending import, including a repeated owner name", () => {
		const path = scratchPath();
		const a = open(path), b = open(path);
		seed(a);
		const first = journal.claimJob(a, "import_jobs", 1, "worker", 1000, NOW);
		expect(first).toMatchObject({ id: 1, state: "pending", owner: "worker" });
		expect(journal.claimJob(b, "import_jobs", 1, "worker", 1000, NOW)).toBeNull();
	});
	test("an expired lease can be reclaimed but its old token cannot mutate or release the job", () => {
		const db = open(); seed(db);
		const old = journal.claimJob(db, "import_jobs", 1, "worker", 1000, NOW)!;
		const replacement = journal.claimJob(db, "import_jobs", 1, "worker", 1000, NOW + 1000)!;
		expect(replacement.token).not.toBe(old.token);
		expect(() => journal.transitionJob(db, old, "spooled", {}, NOW + 1001)).toThrow(/lease/i);
		expect(journal.releaseJob(db, old, NOW + 1001)).toBe(false);
		expect(journal.transitionJob(db, replacement, "spooled", {}, NOW + 1001).state).toBe("spooled");
	});
	test("explicit stage order is enforced and verified imports require canonical readback identifiers", () => {
		const db = open(); seed(db);
		let lease = journal.claimJob(db, "import_jobs", 1, "worker", 1000, NOW)!;
		expect(() => journal.transitionJob(db, lease, "verified", {}, NOW)).toThrow(/transition/i);
		lease = journal.transitionJob(db, lease, "spooled", {}, NOW);
		lease = journal.transitionJob(db, lease, "uploaded", {}, NOW);
		lease = journal.transitionJob(db, lease, "imported", { stalwart_email_id: "e1" }, NOW);
		expect(() => journal.transitionJob(db, lease, "verified", {}, NOW)).toThrow(/readback|canonical/i);
		lease = journal.transitionJob(db, lease, "verified", { stalwart_blob_id: "canonical-b1" }, NOW);
		expect(journal.releaseJob(db, lease, NOW)).toBe(true);
		expect(journal.claimJob(db, "import_jobs", 1, "worker", 1000, NOW)).toBeNull();
	});
	test("CAS rejects a stale stage even with a valid live token", () => {
		const db = open(); seed(db);
		const old = journal.claimJob(db, "import_jobs", 1, "worker", 1000, NOW)!;
		journal.transitionJob(db, old, "spooled", {}, NOW);
		expect(() => journal.transitionJob(db, old, "failed", {}, NOW)).toThrow(/state|transition|lease/i);
		expect((db.prepare("SELECT state FROM import_jobs WHERE id=1").get() as { state: string }).state).toBe("spooled");
	});
	test("unknown submissions are held for reconcile, never reclaimable for retransmission", () => {
		const db = open(); seed(db);
		let lease = journal.claimJob(db, "submission_intents", 1, "sender", 1000, NOW)!;
		lease = journal.transitionJob(db, lease, "submitted", {}, NOW);
		lease = journal.transitionJob(db, lease, "unknown", {}, NOW);
		expect(journal.releaseJob(db, lease, NOW)).toBe(true);
		expect(journal.claimJob(db, "submission_intents", 1, "sender", 1000, NOW + 1000)).toBeNull();
	});
	test("submission acceptance requires a provider id and accepted state is terminal", () => {
		const db = open(); seed(db);
		let lease = journal.claimJob(db, "submission_intents", 1, "sender", 1000, NOW)!;
		lease = journal.transitionJob(db, lease, "submitted", {}, NOW);
		expect(() => journal.transitionJob(db, lease, "accepted", {}, NOW)).toThrow(/provider/i);
		lease = journal.transitionJob(db, lease, "accepted", { provider_id: "p1" }, NOW);
		expect(() => journal.transitionJob(db, lease, "failed", {}, NOW)).toThrow(/transition/i);
	});
	test("an expired submitted lease becomes unknown and cannot be automatically resent", () => {
		const db = open(); seed(db);
		let lease = journal.claimJob(db, "submission_intents", 1, "sender", 1000, NOW)!;
		journal.transitionJob(db, lease, "submitted", {}, NOW);
		expect(journal.claimJob(db, "submission_intents", 1, "sender2", 1000, NOW + 1000)).toBeNull();
		expect(db.prepare("SELECT state FROM submission_intents WHERE id=1").get()).toEqual({ state: "unknown" });
	});
	test("runtime-untrusted table/TTL/owner values are rejected without mutation", () => {
		const db = open(); seed(db);
		expect(typeof journal.claimJob).toBe("function");
		expect(() => journal.claimJob(db, "app_settings" as never, 1, "worker", 1000, NOW)).toThrow();
		expect(() => journal.claimJob(db, "import_jobs", 1, "", 1000, NOW)).toThrow();
		expect(() => journal.claimJob(db, "import_jobs", 1, "worker", -1, NOW)).toThrow();
		expect(db.prepare("SELECT lease_owner FROM import_jobs WHERE id=1").get()).toEqual({ lease_owner: null });
	});
});
