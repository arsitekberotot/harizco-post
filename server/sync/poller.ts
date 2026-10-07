// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: one bounded inbound poll.
//
// Composes discovery -> retrieval -> raw download -> import -> checkpoint into a
// single, bounded unit of work. The ordering is deliberate:
//   1. list a page;
//   2. import every message on it (import persists jobs before any checkpoint);
//   3. advance the checkpoint only for a page that is genuinely complete.
// A page with hasMore=true is imported but never advances the checkpoint past
// itself, so undiscovered pages are re-listed rather than skipped.

import type { Journal } from "../db/index";
import { ResendReceivingClient, type ReceivedEmailSummary } from "../integrations/resend-receiving";
import type { DiscoveryCheckpointStore, DiscoveryService } from "./discovery";
import type { ImportPipeline } from "./import";
import type { PollOutcome } from "./runner";

export interface PollerOptions {
	db: Journal;
	provider: string;
	client: ResendReceivingClient;
	imports: ImportPipeline;
	discovery: DiscoveryService;
	checkpoints: DiscoveryCheckpointStore;
	/** Max messages imported per page; keeps a single run bounded. */
	maxPerPage?: number;
	/** Max pages listed per poll. */
	maxPages?: number;
}

const DEFAULT_MAX_PER_PAGE = 50;
const TYPE = { Imported: "imported", Failed: "failed", Skipped: "skipped" } as const;
type Disposition = (typeof TYPE)[keyof typeof TYPE];

export class InboundPoller {
	readonly #provider: string;
	readonly #client: ResendReceivingClient;
	readonly #imports: ImportPipeline;
	readonly #discovery: DiscoveryService;
	readonly #checkpoints: DiscoveryCheckpointStore;
	readonly #maxPerPage: number;
	readonly #maxPages: number;

	constructor(opts: PollerOptions) {
		void opts.db;
		this.#provider = opts.provider;
		this.#client = opts.client;
		this.#imports = opts.imports;
		this.#discovery = opts.discovery;
		this.#checkpoints = opts.checkpoints;
		this.#maxPerPage = opts.maxPerPage ?? DEFAULT_MAX_PER_PAGE;
		this.#maxPages = opts.maxPages ?? 1;
	}

	/** One bounded poll. Never throws for a per-message failure. */
	poll = async (): Promise<PollOutcome> => {
		const outcome: PollOutcome = { pages: 0, discovered: 0, imported: 0, failed: 0 };

		const cp = this.#checkpoints.read(this.#provider);
		// read() returns a synthetic checkpoint for an unseen provider, so
		// lastPage is -1 and the first page to list is 0.
		const startPage = Math.max(0, (cp?.lastPage ?? -1) + 1);

		for (let i = 0; i < this.#maxPages; i++) {
			const page = startPage + i;

			let listed: Awaited<ReturnType<ResendReceivingClient["listPage"]>>;
			try {
				listed = await this.#client.listPage(page, { limit: this.#maxPerPage });
			} catch {
				// A listing failure ends this poll; the checkpoint stays put so the
				// same page is retried next cycle.
				break;
			}

			outcome.pages += 1;
			outcome.discovered += listed.data.length;

			let lastReceiptId: string | null = null;
			for (const summary of listed.data) {
				lastReceiptId = summary.id;
				const result = await this.#importOne(summary);
				if (result === TYPE.Imported) outcome.imported += 1;
				else if (result === TYPE.Failed) outcome.failed += 1;
				// "skipped" advances neither counter: no job was created or failed.
			}

			// The checkpoint advances only for a complete page. A page reported to
			// have more pages never advances past itself.
			this.#discovery.recordPage(this.#provider, {
				page,
				hasMore: listed.hasMore,
				jobCount: listed.data.length,
				lastReceiptId,
			});

			if (listed.hasMore || !listed.complete) break;
		}

		return outcome;
	};

	/** Import a single receipt. Returns the disposition for accounting. */
	async #importOne(summary: ReceivedEmailSummary): Promise<Disposition> {
		// Provider metadata drives routing. `to` is the envelope recipient list,
		// which is required for Bcc and multi-recipient delivery to work.
		const recipients = Array.isArray(summary.to)
			? summary.to.filter((r): r is string => typeof r === "string")
			: [];
		if (recipients.length === 0) return TYPE.Skipped;

		let bytes: Uint8Array;
		let expectedBytes: number | undefined;
		try {
			const detail = await this.#client.retrieve(summary.id);
			if (!detail.rawAvailable || !detail.raw) return TYPE.Skipped;
			const raw = await this.#client.fetchRaw({ downloadUrl: detail.raw.download_url });
			bytes = raw.bytes;
			expectedBytes = raw.contentLength > 0 ? raw.contentLength : undefined;
		} catch {
			// A retrieval failure is a per-message failure, not a poll failure.
			return TYPE.Failed;
		}

		try {
			const result = await this.#imports.importReceipt({
				provider: this.#provider,
				receiptId: summary.id,
				recipients,
				bytes,
				expectedBytes,
			});
			// No job means no provisioned mailbox matched: skip, never fabricate.
			if (result.jobs.length === 0) return TYPE.Skipped;
			return result.status === "failed" ? TYPE.Failed : TYPE.Imported;
		} catch {
			return TYPE.Failed;
		}
	}
}
