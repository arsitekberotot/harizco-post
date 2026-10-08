// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 6: mailbox configuration and integration journal.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openJournal, type Journal } from "../../server/db/index";
import { MailboxRegistry, RegistryError, deleteMailbox } from "../../server/mailboxes/registry";
import { DEFAULT_SETTINGS, SettingsStore, provisionMailbox, validateSettings } from "../../server/mailboxes/setup";

let db: Journal;
let registry: MailboxRegistry;

beforeEach(() => {
	db = openJournal(":memory:");
	registry = new MailboxRegistry(db);
});

afterEach(() => { db.close(); });

describe("mailbox registry", () => {
	test.each(["false", "true", 0, 1, null])("operator setup rejects non-boolean activation %j before mutation", enable => {
		expect(() => provisionMailbox({ db, registry }, {
			id: "mb1", address: "fixture@example.test", jmapAccountId: "fixture-account", enable: enable as never,
		})).toThrow(RegistryError);
		expect(registry.listAll()).toEqual([]);
	});
	test("a registry from another connection cannot escape the setup transaction", () => {
		const other = openJournal(":memory:");
		try {
			const wrong = new MailboxRegistry(other);
			expect(() => provisionMailbox({ db, registry: wrong }, { id: "mb1", address: "fixture@example.test", enable: true })).toThrow(RegistryError);
			expect(registry.listAll()).toEqual([]);
			expect(wrong.listAll()).toEqual([]);
		} finally { other.close(); }
	});
	test("browser activation can only enable an already operator-provisioned address", () => {
		expect(typeof registry.activateByAddress).toBe("function");
		expect(() => registry.activateByAddress("new@example.test")).toThrow(RegistryError);
		expect(registry.listAll()).toEqual([]);
		registry.provision({ id: "mb1", address: "owner@example.test", jmapAccountId: "account1" });
		expect(registry.activateByAddress("OWNER@example.test")).toMatchObject({ id: "mb1", enabled: 1, jmap_account_id: "account1" });
		expect(registry.listAll()).toHaveLength(1);
	});

	test("unbound identities remain disabled on browser activation", () => {
		registry.provision({ id: "mb1", address: "owner@example.test" });
		expect(typeof registry.activateByAddress).toBe("function");
		expect(() => registry.activateByAddress("owner@example.test")).toThrow(RegistryError);
		expect(registry.getById("mb1")?.enabled).toBe(0);
	});

	test("enable input must be an actual boolean, not a truthy browser string", () => {
		registry.provision({ id: "mb1", address: "a@example.test", jmapAccountId: "account1" });
		expect(() => registry.setEnabled("mb1", "false" as never)).toThrow(RegistryError);
		expect(registry.getById("mb1")?.enabled).toBe(0);
	});
	test("canonical bindings remain immutable after unlink so old mail cannot be silently remapped", () => {
		registry.provision({ id: "mb1", address: "a@example.test", jmapAccountId: "account1" });
		registry.unlink("mb1");
		expect(() => registry.bindAccount("mb1", "account2")).toThrow(RegistryError);
		expect(registry.getById("mb1")?.jmap_account_id).toBe("account1");
	});

	test("control characters are refused in configured identities and initial bindings", () => {
		expect(() => registry.provision({ id: "mb1", address: "a\0@example.test" })).toThrow(RegistryError);
		expect(() => registry.provision({ id: "mb1", address: "a@example.test", jmapAccountId: "\0account" })).toThrow(RegistryError);
		expect(registry.listAll()).toEqual([]);
	});

	test("legacy enabled-but-unbound records never appear as sendable", () => {
		db.prepare("INSERT INTO mailboxes(id,address,enabled,created_at) VALUES ('legacy','legacy@example.test',1,'fixture')").run();
		expect(registry.listEnabled()).toEqual([]);
	});
	test("empty identity and account bindings are refused without mutation", () => {
		expect(() => registry.provision({ id: "", address: "a@example.test" })).toThrow(RegistryError);
		expect(registry.listAll()).toEqual([]);
		registry.provision({ id: "mb1", address: "a@example.test" });
		expect(() => registry.bindAccount("mb1", " ")).toThrow(RegistryError);
		expect(registry.getById("mb1")?.jmap_account_id).toBeNull();
	});

	test("an enabled mailbox cannot silently change canonical account", () => {
		registry.provision({ id: "mb1", address: "a@example.test", jmapAccountId: "account1" });
		registry.setEnabled("mb1", true);
		expect(() => registry.bindAccount("mb1", "account2")).toThrow(RegistryError);
		expect(registry.getById("mb1")?.jmap_account_id).toBe("account1");
		expect(() => registry.bindAccount("mb1", "account1")).not.toThrow();
	});

	test("failed operator setup is atomic and leaves no partial identity", () => {
		expect(() => provisionMailbox({ db, registry }, { id: "mb1", address: "a@example.test", enable: true })).toThrow(RegistryError);
		expect(registry.listAll()).toEqual([]);
	});
	test("operator provisioning stores a normalized address, disabled by default", () => {
		const rec = registry.provision({ id: "mb1", address: "Hanif@Atelieriza.com", displayName: "Hanif" });
		expect(rec.address).toBe("hanif@atelieriza.com");
		expect(rec.enabled).toBe(0);
		expect(rec.jmap_account_id).toBeNull();
	});

	test("provisioning the same address twice is idempotent (no duplicate identity)", () => {
		const a = registry.provision({ id: "mb1", address: "hanif@atelieriza.com" });
		const b = registry.provision({ id: "mb2", address: "HANIF@atelieriza.com" });
		expect(b.id).toBe(a.id);
		expect(registry.listAll()).toHaveLength(1);
	});

	test("invalid addresses are rejected, not silently accepted", () => {
		expect(() => registry.provision({ id: "bad", address: "not-an-address" })).toThrow(RegistryError);
		expect(() => registry.provision({ id: "bad", address: "a@b" })).toThrow(/Not a valid mailbox address/);
	});

	test("a mailbox cannot be enabled without a proven JMAP account binding", () => {
		registry.provision({ id: "mb1", address: "hanif@atelieriza.com" });
		expect(() => registry.setEnabled("mb1", true)).toThrow(/no proven JMAP account binding/);

		registry.bindAccount("mb1", "b-account-1");
		expect(registry.setEnabled("mb1", true).enabled).toBe(1);
	});

	test("listEnabled excludes disabled mailboxes so they are not sendable", () => {
		registry.provision({ id: "mb1", address: "a@atelieriza.com" });
		registry.provision({ id: "mb2", address: "b@atelieriza.com" });
		registry.bindAccount("mb2", "acct-2");
		registry.setEnabled("mb2", true);
		expect(registry.listEnabled().map((m) => m.address)).toEqual(["b@atelieriza.com"]);
	});

	test("unknown mailbox operations fail loudly rather than no-op", () => {
		expect(() => registry.setEnabled("ghost", true)).toThrow(/No such mailbox/);
		expect(() => registry.setDisplayName("ghost", "x")).toThrow(/No such mailbox/);
	});

	test("unlink is non-destructive: canonical binding is preserved", () => {
		registry.provision({ id: "mb1", address: "hanif@atelieriza.com" });
		registry.bindAccount("mb1", "acct-1");
		registry.setEnabled("mb1", true);

		const after = registry.unlink("mb1");
		expect(after.enabled).toBe(0);
		// The JMAP account binding must survive so mail is not orphaned.
		expect(after.jmap_account_id).toBe("acct-1");
	});

	test("browser-driven mailbox deletion is disabled", () => {
		expect(() => deleteMailbox()).toThrow(/deletion is disabled/);
	});

	test("provisionMailbox binds and enables only when explicitly asked", () => {
		const off = provisionMailbox({ db, registry }, { id: "m1", address: "a@x.com" });
		expect(off.enabled).toBe(0);
		const on = provisionMailbox(
			{ db, registry },
			{ id: "m2", address: "b@x.com", jmapAccountId: "acct", enable: true },
		);
		expect(on.enabled).toBe(1);
		expect(on.jmap_account_id).toBe("acct");
	});
});

describe("import job uniqueness", () => {
	test("a replayed provider receipt for the same mailbox cannot create a second job", () => {
		registry.provision({ id: "mb1", address: "hanif@atelieriza.com" });
		const insert = (receipt: string, mailbox: string) =>
			db
				.prepare(
					`INSERT INTO import_jobs
					 (provider, provider_receipt_id, target_mailbox_id, state, created_at, updated_at)
					 VALUES ('resend', ?, ?, 'pending', 'now', 'now')`,
				)
				.run(receipt, mailbox);

		insert("r-1", "mb1");
		expect(() => insert("r-1", "mb1")).toThrow(/UNIQUE|constraint/i);

		// A different target mailbox is legitimately a distinct delivery.
		registry.provision({ id: "mb2", address: "other@atelieriza.com" });
		expect(() => insert("r-1", "mb2")).not.toThrow();
		expect(db.prepare("SELECT COUNT(*) AS n FROM import_jobs").get()).toEqual({ n: 2 });
	});

	test("submission request IDs are unique and carry a payload hash for reuse detection", () => {
		registry.provision({ id: "mb1", address: "hanif@atelieriza.com" });
		const insert = (reqId: string, hash: string) =>
			db
				.prepare(
					`INSERT INTO submission_intents
					 (request_id, mailbox_id, payload_hash, state, created_at, updated_at)
					 VALUES (?, 'mb1', ?, 'intent', 'now', 'now')`,
				)
				.run(reqId, hash);
		insert("req-1", "hash-a");
		expect(() => insert("req-1", "hash-b")).toThrow(/UNIQUE|constraint/i);
	});
});

describe("settings validation", () => {
	test("corrupt stored settings fail closed without echoing the stored body", () => {
		const store = new SettingsStore(db);
		db.prepare("INSERT INTO app_settings(key,value) VALUES ('app_settings',?)").run("opaque-fixture-value invalid-json");
		expect(() => store.read()).toThrow(RegistryError);
		try { store.read(); } catch (error) {
			expect((error as Error).message).not.toContain("opaque-fixture-value");
		}
	});
	test("provider page size follows the actual maximum of 100", () => {
		expect(validateSettings({ providerPageSize: 100 }).providerPageSize).toBe(100);
		expect(() => validateSettings({ providerPageSize: 101 })).toThrow(/providerPageSize/);
	});

	test("partial settings writes preserve earlier fields and malformed writes do not mutate", () => {
		const store = new SettingsStore(db);
		store.write({ publicHostname: "post.example.test", pollIntervalSeconds: 120 });
		store.write({ providerPageSize: 25 });
		expect(store.read()).toMatchObject({ publicHostname: "post.example.test", pollIntervalSeconds: 120, providerPageSize: 25 });
		expect(() => store.write([])).toThrow(RegistryError);
		expect(store.read().providerPageSize).toBe(25);
	});
	test("defaults are bounded and do not permit an unsafe poll interval", () => {
		expect(DEFAULT_SETTINGS.pollIntervalSeconds).toBeGreaterThanOrEqual(30);
		expect(() => validateSettings({ pollIntervalSeconds: 1 })).toThrow(/between 30 and 86400/);
	});

	test("settings round-trip through storage", () => {
		const store = new SettingsStore(db);
		expect(store.read()).toEqual(DEFAULT_SETTINGS);
		const written = store.write({ pollIntervalSeconds: 120, providerPageSize: 25 });
		expect(written.pollIntervalSeconds).toBe(120);
		expect(store.read().providerPageSize).toBe(25);
	});

	test("unknown keys are dropped, not persisted", () => {
		const store = new SettingsStore(db);
		store.write({ pollIntervalSeconds: 90, evil: "rm -rf /" } as unknown);
		expect(store.read()).not.toHaveProperty("evil");
	});

	test("out-of-range and wrong-typed values are rejected", () => {
		expect(() => validateSettings({ quarantineLimit: 0 })).toThrow(/quarantineLimit/);
		expect(() => validateSettings({ spoolLimitBytes: 10 })).toThrow(/spoolLimitBytes/);
		expect(() => validateSettings({ providerPageSize: 10_000 })).toThrow(/providerPageSize/);
		expect(() => validateSettings([])).toThrow(/JSON object/);
	});
});
