// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 11: raw-MIME import and crash recovery.
//
// The journal and Stalwart cannot share a transaction. These tests inject a
// crash at each stage boundary and assert that mail is never silently lost or
// duplicated: every ambiguous state is either reconciled or visibly held.

import { beforeEach, describe, expect, test } from "vitest";
import { openJournal, type Journal } from "../../server/db/index";
import { MailboxRegistry } from "../../server/mailboxes/registry";
import { RecipientRouter } from "../../server/sync/recipients";
import {
	ImportPipeline,
	type ImportFaultPoint,
	type SpoolPort,
	type JmapImportPort,
} from "../../server/sync/import";
import { reconcileImportJobs } from "../../server/sync/reconcile";

interface Harness {
	db: Journal;
	pipeline: ImportPipeline;
	jmap: FakeJmap;
	spool: FakeSpool;
	mailboxId: string;
	router: RecipientRouter;
}

class FakeSpool implements SpoolPort {
	readonly written = new Map<string, Uint8Array>();
	readonly released: string[] = [];
	#n = 0;

	async write(bytes: Uint8Array): Promise<string> {
		const key = `spool-${++this.#n}`;
		this.written.set(key, bytes);
		return key;
	}
	async read(key: string): Promise<Uint8Array> {
		const bytes = this.written.get(key);
		if (!bytes) throw new Error(`missing spool key ${key}`);
		return bytes;
	}
	async release(key: string): Promise<void> {
		this.released.push(key);
	}
}

class FakeJmap implements JmapImportPort {
	readonly uploaded: Uint8Array[] = [];
	readonly imported: { mailboxId: string; blobId: string }[] = [];
	#n = 0;
	/** Blobs currently present in "Stalwart", by email id. */
	readonly store = new Map<string, { blobId: string; bytes: Uint8Array }>();

	async upload(bytes: Uint8Array): Promise<string> {
		this.uploaded.push(bytes);
		const blobId = `blob-${++this.#n}`;
		return blobId;
	}
	async importEmail(input: { mailboxId: string; blobId: string; bytes: Uint8Array }): Promise<{ emailId: string }> {
		this.imported.push({ mailboxId: input.mailboxId, blobId: input.blobId });
		const emailId = `email-${this.#n}`;
		this.store.set(emailId, { blobId: input.blobId, bytes: input.bytes });
		return { emailId };
	}
	async readback(emailId: string): Promise<{ emailId: string; blobId: string; size: number } | null> {
		const found = this.store.get(emailId);
		if (!found) return null;
		return { emailId, blobId: found.blobId, size: found.bytes.byteLength };
	}
	/** Find an existing import by blob content, used for reconciliation. */
	async findByContentHash(hash: string): Promise<{ emailId: string; blobId: string } | null> {
		for (const [emailId, rec] of this.store) {
			if (hashOf(rec.bytes) === hash) return { emailId, blobId: rec.blobId };
		}
		return null;
	}
}

function hashOf(bytes: Uint8Array): string {
	// Deterministic, dependency-free digest for test comparison.
	let h = 2166136261;
	for (const b of bytes) {
		h ^= b;
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

async function build(faults: ImportFaultPoint[] = []): Promise<Harness> {
	const db = openJournal(":memory:");
	const registry = new MailboxRegistry(db);
	registry.provision({ id: "mb-hanif", address: "hanif@atelieriza.com" });
	registry.bindAccount("mb-hanif", "acct-1");
	registry.setEnabled("mb-hanif", true);
	const router = new RecipientRouter({ db, registry });

	const jmap = new FakeJmap();
	const spool = new FakeSpool();
	const pipeline = new ImportPipeline({
		db,
		router,
		spool,
		jmap,
		mailboxIdResolver: () => "acct-1",
		faultInjector: (point) => {
			if (faults.includes(point)) throw new Error(`injected fault at ${point}`);
		},
	});
	return { db, pipeline, jmap, spool, mailboxId: "mb-hanif", router };
}

const MIME = new TextEncoder().encode(
	"From: sender@example.com\r\nTo: hanif@atelieriza.com\r\nSubject: Hi\r\n\r\nBody text\r\n",
);

describe("happy path", () => {
	test("imports exact bytes, verifies readback, then commits", async () => {
		const h = await build();
		const result = await h.pipeline.importReceipt({
			provider: "resend",
			receiptId: "r1",
			recipients: ["hanif@atelieriza.com"],
			bytes: MIME,
		});

		expect(result.status).toBe("imported");
		expect(result.jobs).toHaveLength(1);
		expect(result.jobs[0].state).toBe("verified");
		// The exact bytes must reach Stalwart unchanged.
		expect(h.jmap.uploaded[0]).toEqual(MIME);
		// Temporary spool is released only after verification.
		expect(h.spool.released).toHaveLength(1);
	});

	test("imports each recipient only through that mailbox's JMAP account", async () => {
		const db = openJournal(":memory:");
		const registry = new MailboxRegistry(db);
		registry.provision({ id: "mb-hanif", address: "hanif@atelieriza.com" });
		registry.bindAccount("mb-hanif", "acct-hanif");
		registry.setEnabled("mb-hanif", true);
		registry.provision({ id: "mb-natla", address: "natla@atelieriza.com" });
		registry.bindAccount("mb-natla", "acct-natla");
		registry.setEnabled("mb-natla", true);
		const router = new RecipientRouter({ db, registry });
		const spool = new FakeSpool();
		const hanifJmap = new FakeJmap();
		const natlaJmap = new FakeJmap();
		const adapters = new Map([["mb-hanif", hanifJmap], ["mb-natla", natlaJmap]]);
		const pipeline = new ImportPipeline({
			db,
			router,
			spool,
			jmap: hanifJmap,
			jmapForMailbox: (mailboxId: string) => adapters.get(mailboxId)!,
			mailboxIdResolver: (mailboxId: string) => registry.getById(mailboxId)?.jmap_account_id ?? "",
		});

		const result = await pipeline.importReceipt({
			provider: "resend",
			receiptId: "multi-recipient",
			recipients: ["hanif@atelieriza.com", "natla@atelieriza.com"],
			bytes: MIME,
		});
		expect(result.status).toBe("imported");
		expect(hanifJmap.imported.map((entry) => entry.mailboxId)).toEqual(["acct-hanif"]);
		expect(natlaJmap.imported.map((entry) => entry.mailboxId)).toEqual(["acct-natla"]);
	});
});

describe("fault injection", () => {
	test("failure before upload leaves a retryable job with no Stalwart write", async () => {
		const h = await build(["before_upload"]);
		// Per-target failures are contained and reported, never thrown: one bad
		// target must not erase successful delivery to another.
		const result = await h.pipeline.importReceipt({
			provider: "resend",
			receiptId: "r1",
			recipients: ["hanif@atelieriza.com"],
			bytes: MIME,
		});
		expect(result.status).toBe("failed");
		expect(result.jobs[0].state).toBe("failed");
		expect(result.jobs[0].error).toMatch(/before_upload/);

		const job = h.db.prepare("SELECT state, attempts, last_error FROM import_jobs").get() as {
			state: string;
			attempts: number;
			last_error: string;
		};
		expect(job.state).toBe("failed");
		expect(job.attempts).toBe(1);
		expect(job.last_error).toMatch(/before_upload/);
		expect(h.jmap.imported).toHaveLength(0);
	});

	test("failure after upload but before import leaves no visible message", async () => {
		const h = await build(["after_upload"]);
		const result = await h.pipeline.importReceipt({
			provider: "resend",
			receiptId: "r1",
			recipients: ["hanif@atelieriza.com"],
			bytes: MIME,
		});
		expect(result.jobs[0].state).toBe("failed");
		expect(h.jmap.imported).toHaveLength(0);
		expect(h.jmap.store.size).toBe(0);
	});

	test("crash after import but before journal commit is reconciled, not duplicated", async () => {
		const h = await build(["after_import"]);

		const first = await h.pipeline.importReceipt({
			provider: "resend",
			receiptId: "r1",
			recipients: ["hanif@atelieriza.com"],
			bytes: MIME,
		});
		expect(first.jobs[0].state).toBe("failed");

		// The message did land in Stalwart, but the journal never confirmed it.
		expect(h.jmap.store.size).toBe(1);
		const job = h.db.prepare("SELECT state, stalwart_email_id FROM import_jobs").get() as {
			state: string;
			stalwart_email_id: string | null;
		};
		expect(job.state).toBe("failed");
		// The post-import journal commit names the message that exists, which is
		// exactly what lets reconciliation adopt it instead of guessing.
		expect(job.stalwart_email_id).toBeTruthy();

		// Reconciliation must adopt the existing message, not import a second copy.
		const report = await reconcileImportJobs({ db: h.db, jmap: h.jmap });
		expect(report.adopted).toBe(1);
		expect(h.jmap.store.size).toBe(1);
		expect(h.jmap.imported).toHaveLength(1);

		const after = h.db.prepare("SELECT state, stalwart_email_id FROM import_jobs").get() as {
			state: string;
			stalwart_email_id: string | null;
		};
		expect(after.state).toBe("verified");
		expect(after.stalwart_email_id).toBeTruthy();
	});

	test("a retry after reconciliation does not create a second visible copy", async () => {
		const h = await build(["after_import"]);
		await h.pipeline
			.importReceipt({ provider: "resend", receiptId: "r1", recipients: ["hanif@atelieriza.com"], bytes: MIME })
			.catch(() => null);
		await reconcileImportJobs({ db: h.db, jmap: h.jmap });

		// Replaying the same receipt now finds the job already verified.
		const replay = await h.pipeline.importReceipt({
			provider: "resend",
			receiptId: "r1",
			recipients: ["hanif@atelieriza.com"],
			bytes: MIME,
		});
		expect(replay.status).toBe("already_imported");
		expect(h.jmap.store.size).toBe(1);
	});

	test("a crash after readback but before the verified commit is adopted from the recorded id", async () => {
		const h = await build(["before_commit"]);
		await h.pipeline.importReceipt({
			provider: "resend",
			receiptId: "r1",
			recipients: ["hanif@atelieriza.com"],
			bytes: MIME,
		});

		// The message exists in Stalwart and the journal already names it, so
		// reconciliation adopts it by direct readback -- no guessing, no copy.
		expect(h.jmap.store.size).toBe(1);
		const report = await reconcileImportJobs({ db: h.db, jmap: h.jmap });
		expect(report.adopted).toBe(1);
		expect(h.jmap.store.size).toBe(1);
		const job = h.db.prepare("SELECT state FROM import_jobs").get() as { state: string };
		expect(job.state).toBe("verified");
	});

	test("a job with no recorded email id is held, never guessed into a verified state", async () => {
		const h = await build();
		// Simulate the genuinely ambiguous case: a blob upload happened but the
		// import never returned, so no email id exists to verify against.
		h.router.ensureJobs("resend", "r-ambiguous", ["mb-hanif"]);
		h.db
			.prepare("UPDATE import_jobs SET state = 'uploaded', stalwart_blob_id = 'blob-x' WHERE provider_receipt_id = ?")
			.run("r-ambiguous");

		const report = await reconcileImportJobs({ db: h.db, jmap: h.jmap });
		expect(report.adopted).toBe(0);
		expect(report.stillFailed).toBe(1);
		const job = h.db
			.prepare("SELECT state FROM import_jobs WHERE provider_receipt_id = ?")
			.get("r-ambiguous") as { state: string };
		expect(job.state).toBe("uploaded");
	});
});

describe("multi-target delivery", () => {
	test("imports once per intended mailbox and one failure does not erase the other", async () => {
		const db = openJournal(":memory:");
		const registry = new MailboxRegistry(db);
		for (const [id, address] of [
			["mb-hanif", "hanif@atelieriza.com"],
			["mb-support", "support@atelieriza.com"],
		] as const) {
			registry.provision({ id, address });
			registry.bindAccount(id, `acct-${id}`);
			registry.setEnabled(id, true);
		}
		const router = new RecipientRouter({ db, registry });
		const jmap = new FakeJmap();
		const spool = new FakeSpool();
		let failFor = "mb-support";
		const pipeline = new ImportPipeline({
			db,
			router,
			spool,
			jmap,
			mailboxIdResolver: () => "acct-1",
			faultInjector: () => {},
			shouldFailTarget: (mailboxId) => mailboxId === failFor,
		});

		const result = await pipeline.importReceipt({
			provider: "resend",
			receiptId: "r1",
			recipients: ["hanif@atelieriza.com", "support@atelieriza.com"],
			bytes: MIME,
		});

		const states = Object.fromEntries(result.jobs.map((j) => [j.mailboxId, j.state]));
		expect(states["mb-hanif"]).toBe("verified");
		expect(states["mb-support"]).toBe("failed");
		// The successful target is genuinely present.
		expect(jmap.store.size).toBe(1);
		void failFor;
	});
});

describe("integrity", () => {
	test("a truncated download is rejected before upload", async () => {
		const h = await build();
		await expect(
			h.pipeline.importReceipt({
				provider: "resend",
				receiptId: "r1",
				recipients: ["hanif@atelieriza.com"],
				bytes: new Uint8Array(0),
				expectedBytes: 120,
			}),
		).rejects.toThrow(/incomplete/i);
		expect(h.jmap.uploaded).toHaveLength(0);
	});

	test("a readback mismatch holds the job rather than marking it verified", async () => {
		const h = await build();
		const original = h.jmap.readback.bind(h.jmap);
		h.jmap.readback = async (id: string) => {
			const rec = await original(id);
			return rec ? { ...rec, blobId: "wrong-blob" } : null;
		};
		const result = await h.pipeline.importReceipt({
			provider: "resend",
			receiptId: "r1",
			recipients: ["hanif@atelieriza.com"],
			bytes: MIME,
		});
		expect(result.jobs[0].state).toBe("failed");
	});
});
