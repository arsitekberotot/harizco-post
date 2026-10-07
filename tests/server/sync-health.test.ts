// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 12: sync worker loop, health, and authenticated status route.

import { beforeEach, describe, expect, test } from "vitest";
import { openJournal, type Journal } from "../../server/db/index";
import { MailboxRegistry } from "../../server/mailboxes/registry";
import { RecipientRouter } from "../../server/sync/recipients";
import { SyncRunner } from "../../server/sync/runner";
import { buildStatusReport, redactForLog } from "../../server/routes/status";

let db: Journal;

beforeEach(() => {
	db = openJournal(":memory:");
	const registry = new MailboxRegistry(db);
	registry.provision({ id: "mb-hanif", address: "hanif@atelieriza.com" });
	registry.bindAccount("mb-hanif", "acct-1");
	registry.setEnabled("mb-hanif", true);
});

function makeRunner(overrides: Partial<ConstructorParameters<typeof SyncRunner>[0]> = {}) {
	const registry = new MailboxRegistry(db);
	const router = new RecipientRouter({ db, registry });
	return new SyncRunner({
		db,
		router,
		intervalSeconds: 60,
		owner: "worker-1",
		poll: async () => ({ pages: 1, discovered: 0, imported: 0, failed: 0 }),
		...overrides,
	});
}

describe("leased single poller", () => {
	test("only one worker may hold the poll lease at a time", () => {
		const a = makeRunner({ owner: "worker-a" });
		const b = makeRunner({ owner: "worker-b" });
		expect(a.acquireLease()).toBe(true);
		// A second poller must not start a second overlapping run.
		expect(b.acquireLease()).toBe(false);
		expect(a.holdingLease()).toBe(true);
	});

	test("an expired lease is reclaimable after a crash", () => {
		const a = makeRunner({ owner: "worker-a" });
		a.acquireLease(0);
		const b = makeRunner({ owner: "worker-b" });
		// Lease already expired, so recovery is allowed.
		expect(b.acquireLease(0)).toBe(true);
	});

	test("graceful shutdown releases the lease", () => {
		const runner = makeRunner();
		runner.acquireLease();
		runner.stop();
		expect(runner.holdingLease()).toBe(false);
	});

	test("a run does not start while another is in flight", async () => {
		let runs = 0;
		const runner = makeRunner({
			poll: async () => {
				runs += 1;
				await new Promise((r) => setTimeout(r, 20));
				return { pages: 1, discovered: 0, imported: 0, failed: 0 };
			},
		});
		await Promise.all([runner.runOnce(), runner.runOnce()]);
		expect(runs).toBe(1);
	});

	test("backoff grows on provider errors and resets on success", () => {
		const runner = makeRunner();
		runner.recordFailure("rate_limited");
		const first = runner.nextDelaySeconds();
		runner.recordFailure("rate_limited");
		const second = runner.nextDelaySeconds();
		expect(second).toBeGreaterThan(first);
		runner.recordSuccess();
		expect(runner.nextDelaySeconds()).toBe(60);
	});
});

describe("health reporting", () => {
	test("reports last success, oldest pending item, failure and quarantine counts", () => {
		const router = new RecipientRouter({ db, registry: new MailboxRegistry(db) });
		router.ensureJobs("resend", "r1", ["mb-hanif"]);
		db.prepare(
			"INSERT INTO import_jobs (provider, provider_receipt_id, target_mailbox_id, state, created_at, updated_at) VALUES ('resend','r2','mb-hanif','failed','now','now')",
		).run();
		db.prepare(
			"INSERT INTO import_jobs (provider, provider_receipt_id, target_mailbox_id, state, created_at, updated_at) VALUES ('resend','r3','mb-hanif','quarantined','now','now')",
		).run();

		const report = buildStatusReport({ db, lastSuccessAt: "2026-10-07T10:00:00Z" });
		expect(report.lastSuccessAt).toBe("2026-10-07T10:00:00Z");
		expect(report.pending).toBe(1);
		expect(report.failed).toBe(1);
		expect(report.quarantined).toBe(1);
		expect(report.oldestPendingAt).toBeTruthy();
	});

	test("status output never contains mail bodies, recipients, tokens, or signed URLs", () => {
		const sample = {
			subject: "Secret subject",
			to: ["customer@example.com"],
			apiKey: "re_abcdef123456",
			downloadUrl: "https://dl.resend.com/x?token=abc123",
		};
		const redacted = redactForLog(sample);
		const text = JSON.stringify(redacted);
		expect(text).not.toContain("re_abcdef123456");
		expect(text).not.toContain("abc123");
		expect(text).not.toContain("customer@example.com");
		expect(text).not.toContain("Secret subject");
	});

	test("redaction keeps operationally useful fields", () => {
		const redacted = redactForLog({ providerReceiptId: "r-1", state: "failed", attempts: 2 });
		expect(redacted).toMatchObject({ providerReceiptId: "r-1", state: "failed", attempts: 2 });
	});
});
