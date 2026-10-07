// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 10: recipient routing and discovery jobs.

import { beforeEach, describe, expect, test } from "vitest";
import { openJournal, type Journal } from "../../server/db/index";
import { MailboxRegistry } from "../../server/mailboxes/registry";
import { RecipientRouter } from "../../server/sync/recipients";
import { DiscoveryService, DiscoveryCheckpointStore } from "../../server/sync/discovery";

let db: Journal;
let registry: MailboxRegistry;
let router: RecipientRouter;

beforeEach(() => {
	db = openJournal(":memory:");
	registry = new MailboxRegistry(db);
	registry.provision({ id: "mb-hanif", address: "hanif@atelieriza.com" });
	registry.bindAccount("mb-hanif", "acct-1");
	registry.setEnabled("mb-hanif", true);
	registry.provision({ id: "mb-support", address: "support@atelieriza.com" });
	registry.bindAccount("mb-support", "acct-2");
	registry.setEnabled("mb-support", true);
	router = new RecipientRouter({ db, registry });
});

describe("recipient routing", () => {
	test("routes using provider-supplied recipient metadata, case-insensitively", () => {
		const targets = router.resolve(["HANIF@Atelieriza.com"]);
		expect(targets.map((t) => t.mailboxId)).toEqual(["mb-hanif"]);
	});

	test("one message addressed to two owned mailboxes fans out to both", () => {
		const targets = router.resolve(["hanif@atelieriza.com", "support@atelieriza.com"]);
		expect(targets.map((t) => t.mailboxId).sort()).toEqual(["mb-hanif", "mb-support"]);
	});

	test("a Bcc-only recipient still routes even though it is absent from To/Cc headers", () => {
		// Provider metadata lists the envelope recipient; visible headers do not.
		const targets = router.resolve(["support@atelieriza.com"]);
		expect(targets).toHaveLength(1);
		expect(targets[0].mailboxId).toBe("mb-support");
	});

	test("duplicate recipients produce one target per mailbox, not duplicates", () => {
		const targets = router.resolve([
			"hanif@atelieriza.com",
			"hanif@atelieriza.com",
			"hanif@atelieriza.com",
		]);
		expect(targets).toHaveLength(1);
	});

	test("an unknown address is quarantined, never auto-provisioned as a sender", () => {
		const before = registry.listAll().length;
		const targets = router.resolve(["stranger@elsewhere.com"]);
		expect(targets).toHaveLength(0);
		expect(router.lastUnmatched).toEqual(["stranger@elsewhere.com"]);
		// No new sendable identity may appear as a side effect of receiving mail.
		expect(registry.listAll().length).toBe(before);
	});

	test("a disabled mailbox is not a delivery target", () => {
		registry.unlink("mb-support");
		const targets = router.resolve(["support@atelieriza.com"]);
		expect(targets).toHaveLength(0);
	});

	test("one failed target does not erase successful delivery to another", () => {
		const targets = router.resolve(["hanif@atelieriza.com", "support@atelieriza.com"]);
		expect(targets).toHaveLength(2);
		// Each target gets an independent job identity.
		const ids = router.ensureJobs("resend", "receipt-1", targets.map((t) => t.mailboxId));
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	test("unknown recipients are deduplicated and bounded", () => {
		router.resolve(["a@x.com", "a@x.com", "b@x.com"]);
		expect(router.lastUnmatched).toEqual(["a@x.com", "b@x.com"]);
	});
});

describe("discovery jobs", () => {
	test("a job is persisted before any import is attempted", () => {
		const targets = router.resolve(["hanif@atelieriza.com"]);
		router.ensureJobs("resend", "receipt-1", targets.map((t) => t.mailboxId));
		const rows = db.prepare("SELECT state FROM import_jobs").all() as { state: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].state).toBe("pending");
	});

	test("replaying the same receipt for the same mailbox is idempotent", () => {
		const targets = router.resolve(["hanif@atelieriza.com"]);
		const a = router.ensureJobs("resend", "receipt-1", targets.map((t) => t.mailboxId));
		const b = router.ensureJobs("resend", "receipt-1", targets.map((t) => t.mailboxId));
		expect(b).toEqual(a);
		expect(db.prepare("SELECT COUNT(*) AS n FROM import_jobs").get()).toEqual({ n: 1 });
	});

	test("the checkpoint only advances after jobs are persisted, and keeps an overlap", () => {
		const store = new DiscoveryCheckpointStore(db);
		expect(store.read("resend")).toMatchObject({ lastPage: -1, overlapFrom: null });

		router.ensureJobs("resend", "receipt-1", ["mb-hanif"]);
		store.advance("resend", { lastPage: 0, overlapFrom: "receipt-1" });
		const cp = store.read("resend")!;
		expect(cp.lastPage).toBe(0);
		// An overlap boundary is retained so reconciliation can re-see recent mail.
		expect(cp.overlapFrom).toBe("receipt-1");
	});

	test("a page with has_more=true does not advance the checkpoint", () => {
		const store = new DiscoveryCheckpointStore(db);
		const service = new DiscoveryService({ db, router, checkpoints: store });
		service.recordPage("resend", { page: 0, hasMore: true, jobCount: 0, lastReceiptId: "r1" });
		// Incomplete page: checkpoint must not move.
		expect(store.read("resend")).toMatchObject({ lastPage: -1 });
	});

	test("a complete page advances the checkpoint", () => {
		const store = new DiscoveryCheckpointStore(db);
		const service = new DiscoveryService({ db, router, checkpoints: store });
		service.recordPage("resend", { page: 3, hasMore: false, jobCount: 2, lastReceiptId: "r9" });
		expect(store.read("resend")).toMatchObject({ lastPage: 3, overlapFrom: "r9" });
	});

	test("failed jobs remain separately retryable after the checkpoint has moved on", () => {
		router.ensureJobs("resend", "receipt-1", ["mb-hanif"]);
		db.prepare("UPDATE import_jobs SET state = 'failed', last_error = 'boom'").run();
		const store = new DiscoveryCheckpointStore(db);
		store.advance("resend", { lastPage: 5, overlapFrom: "receipt-9" });

		const retryable = db.prepare("SELECT provider_receipt_id FROM import_jobs WHERE state = 'failed'").all();
		expect(retryable).toEqual([{ provider_receipt_id: "receipt-1" }]);
	});

	test("a complete scan is required before the discovery loop is considered caught up", () => {
		const store = new DiscoveryCheckpointStore(db);
		const service = new DiscoveryService({ db, router, checkpoints: store });
		expect(service.isCaughtUp("resend")).toBe(false);
		service.recordPage("resend", { page: 0, hasMore: false, jobCount: 0, lastReceiptId: "r1" });
		expect(service.isCaughtUp("resend")).toBe(true);
	});
});
