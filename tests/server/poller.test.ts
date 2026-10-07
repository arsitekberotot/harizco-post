// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Phase 3 wiring contract: the bounded inbound poll composes discovery,
// retrieval, import, and checkpointing, and never advances the checkpoint past
// an incomplete page.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { openJournal, type Journal } from "../../server/db/index";
import { MailboxRegistry } from "../../server/mailboxes/registry";
import { RecipientRouter } from "../../server/sync/recipients";
import { DiscoveryCheckpointStore, DiscoveryService } from "../../server/sync/discovery";
import { ImportPipeline, type JmapImportPort, type SpoolPort } from "../../server/sync/import";
import { InboundPoller } from "../../server/sync/poller";
import type { PageResult, ReceivedEmailDetail, ReceivedEmailSummary } from "../../server/integrations/resend-receiving";

type FakeClient = {
	listPage: (page: number, opts: { limit?: number }) => Promise<PageResult<ReceivedEmailSummary>>;
	retrieve: (id: string) => Promise<ReceivedEmailDetail>;
	fetchRaw: (input: { downloadUrl: string }) => Promise<{ bytes: Uint8Array; contentLength: number }>;
};

function fakeSpool(): SpoolPort {
	const store = new Map<string, Uint8Array>();
	let n = 0;
	return {
		async write(bytes) {
			const key = `spool-${n++}`;
			store.set(key, bytes);
			return key;
		},
		async read(key) {
			const v = store.get(key);
			if (!v) throw new Error("missing spool key");
			return v;
		},
		async release(key) {
			store.delete(key);
		},
	};
}

function fakeJmap(): JmapImportPort {
	let n = 0;
	// Track the blob and byte length each import was created from so readback
	// returns a consistent blobId/size: the pipeline verifies the canonical copy
	// matches the uploaded bytes, and a mismatched fake would (correctly) fail.
	const infoByEmail = new Map<string, { blobId: string; size: number }>();
	return {
		async upload() {
			return `blob-${n++}`;
		},
		async importEmail(input) {
			const emailId = `email-${n++}`;
			infoByEmail.set(emailId, { blobId: input.blobId, size: input.bytes.byteLength });
			return { emailId };
		},
		async readback(emailId) {
			const info = infoByEmail.get(emailId);
			if (!info) return null;
			return { emailId, blobId: info.blobId, size: info.size };
		},
		async findByContentHash() {
			return null;
		},
	};
}

function seedMailbox(db: Journal, id: string, address: string): void {
	const reg = new MailboxRegistry(db);
	reg.provision({ id, address, displayName: name(address) });
	// Routing only targets enabled, account-bound mailboxes.
	reg.bindAccount(id, "acct-1");
	reg.setEnabled(id, true);
}

function name(address: string): string {
	return address.split("@")[0];
}

function buildPage(page: number, ids: string[], hasMore: boolean, complete: boolean): PageResult<ReceivedEmailSummary> {
	return {
		data: ids.map((id) => ({ id, to: ["owner@example.invalid"] })),
		hasMore,
		complete,
		page,
		pageSize: ids.length,
	};
}

describe("Phase 3: bounded inbound poll", () => {
	let db: Journal;

	beforeEach(() => {
		db = openJournal(":memory:");
		seedMailbox(db, "mb-1", "owner@example.invalid");
	});

	function buildPoller(client: FakeClient) {
		const registry = new MailboxRegistry(db);
		const router = new RecipientRouter({ db, registry });
		const checkpoints = new DiscoveryCheckpointStore(db);
		const discovery = new DiscoveryService({ db, router, checkpoints });
		const imports = new ImportPipeline({
			db,
			router,
			spool: fakeSpool(),
			jmap: fakeJmap(),
			mailboxIdResolver: () => "acct-1",
		});
		const poller = new InboundPoller({
			db,
			provider: "resend",
			client: client as unknown as ConstructorParameters<typeof InboundPoller>[0]["client"],
			imports,
			discovery,
			checkpoints,
		});
		return { poller, checkpoints };
	}

	test("imports every message on a complete page and advances the checkpoint", async () => {
		const listPage = vi.fn(async (page: number) =>
			page === 0 ? buildPage(0, ["r-1", "r-2"], false, true) : buildPage(page, [], false, true),
		);
		const client: FakeClient = {
			listPage,
			retrieve: async (id) => ({
				id,
				to: ["owner@example.invalid"],
				raw: { download_url: "https://api.resend.com/raw/x", expires_at: future() },
				rawAvailable: true,
			}),
			fetchRaw: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentLength: 3 }),
		};
		const { poller, checkpoints } = buildPoller(client);

		const outcome = await poller.poll();
		expect(outcome.discovered).toBe(2);
		expect(outcome.imported).toBe(2);
		expect(outcome.failed).toBe(0);
		// A complete page advances the checkpoint.
		expect(checkpoints.read("resend")?.lastPage).toBe(0);
	});

	test("does not advance the checkpoint past a page that has more", async () => {
		const client: FakeClient = {
			listPage: async (page) => buildPage(page, ["r-1"], true, false),
			retrieve: async (id) => ({
				id,
				to: ["owner@example.invalid"],
				raw: { download_url: "https://api.resend.com/raw/x", expires_at: future() },
				rawAvailable: true,
			}),
			fetchRaw: async () => ({ bytes: new Uint8Array([1]), contentLength: 1 }),
		};
		const { poller, checkpoints } = buildPoller(client);

		await poller.poll();
		// lastPage stays -1 (synthetic unseen) because the page was incomplete.
		expect(checkpoints.read("resend")?.lastPage).toBe(-1);
	});

	test("a raw retrieval failure is counted as failed, not imported", async () => {
		const client: FakeClient = {
			listPage: async (page) => (page === 0 ? buildPage(0, ["r-1"], false, true) : buildPage(page, [], false, true)),
			retrieve: async () => {
				throw new Error("provider 500");
			},
			fetchRaw: async () => ({ bytes: new Uint8Array([1]), contentLength: 1 }),
		};
		const { poller } = buildPoller(client);
		const outcome = await poller.poll();
		expect(outcome.failed).toBe(1);
		expect(outcome.imported).toBe(0);
	});

	test("a message to an unknown address is skipped, never fabricated into a mailbox", async () => {
		const client: FakeClient = {
			listPage: async (page) =>
				page === 0
					? {
							data: [{ id: "r-1", to: ["stranger@elsewhere.invalid"] }],
							hasMore: false,
							complete: true,
							page: 0,
							pageSize: 1,
						}
					: buildPage(page, [], false, true),
			retrieve: async (id) => ({
				id,
				to: ["stranger@elsewhere.invalid"],
				raw: { download_url: "https://api.resend.com/raw/x", expires_at: future() },
				rawAvailable: true,
			}),
			fetchRaw: async () => ({ bytes: new Uint8Array([1]), contentLength: 1 }),
		};
		const { poller } = buildPoller(client);
		const outcome = await poller.poll();
		expect(outcome.imported).toBe(0);
		expect(outcome.failed).toBe(0);
		// No mailbox was created for the stranger.
		const rows = db.prepare("SELECT COUNT(*) AS n FROM mailboxes").get() as { n: number };
		expect(rows.n).toBe(1);
	});

	test("a listing failure ends the poll without throwing", async () => {
		const client: FakeClient = {
			listPage: async () => {
				throw new Error("network down");
			},
			retrieve: async () => {
				throw new Error("unreachable");
			},
			fetchRaw: async () => ({ bytes: new Uint8Array([1]), contentLength: 1 }),
		};
		const { poller } = buildPoller(client);
		const outcome = await poller.poll();
		expect(outcome.pages).toBe(0);
		expect(outcome.imported).toBe(0);
	});
});

function future(): string {
	return new Date(Date.now() + 3600_000).toISOString();
}
