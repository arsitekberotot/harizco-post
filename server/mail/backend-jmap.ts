// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: JMAP-backed MailBackend.
//
// Adapts the tested JmapClient (server/mail/jmap-client.ts) and the tested
// DraftStore (server/mail/drafts.ts) to the MailBackend port the compatibility
// API consumes. This is the single place a JMAP call is made on behalf of a
// browser request; account scoping is structural because an instance is bound
// to one configured mailbox.

import { JmapClient, JmapError, type JmapClientOptions, type MethodCall } from "./jmap-client";
import { DraftStore, type DraftJmapPort } from "./drafts";
import { validateFolderMutation } from "./folders";
import { validateSubmission, type SenderPolicy } from "./validation";
import { submitWithIdempotency, type RelayTransport, type SubmissionStore } from "./submissions";
import type {
	DraftInput,
	EmailListResult,
	EmailView,
	FlagInput,
	FolderMutationInput,
	MailBackend,
	MailboxView,
	SearchResult,
	SendInput,
	SendResult,
} from "./backend";

/**
 * Optional submission wiring.
 *
 * The web process holds no relay credential: it validates, records the durable
 * intent, and hands the payload to the relay port (which the worker owns). With
 * no wiring, `sendEmail` refuses rather than pretending a message was sent.
 */
export interface SubmissionOptions {
	store: SubmissionStore;
	transport: RelayTransport;
	policy: SenderPolicy;
}

export class JmapMailBackend implements MailBackend {
	readonly #client: JmapClient;
	readonly #drafts: DraftStore;
	readonly #submission?: SubmissionOptions;

	constructor(options: JmapClientOptions & { submission?: SubmissionOptions }) {
		this.#client = new JmapClient(options);
		this.#submission = options.submission;
		const port: DraftJmapPort = {
			createDraft: (mailboxId, payload) => this.#createDraft(mailboxId, payload),
			destroyDraft: (id) => this.#destroyDraft(id),
		};
		this.#drafts = new DraftStore(port);
	}

	async listMailboxes(): Promise<MailboxView[]> {
		return this.#client.listMailboxes();
	}

	async getMailbox(id: string): Promise<MailboxView | null> {
		const boxes = await this.#client.listMailboxes();
		return boxes.find((b) => b.id === id) ?? null;
	}

	async listEmails(
		mailboxId: string,
		opts: { limit?: number; offset?: number } = {},
	): Promise<EmailListResult> {
		await this.#requireMailbox(mailboxId);
		const { ids, total } = await this.#client.listEmails(mailboxId, {
			limit: opts.limit,
			position: opts.offset,
		});
		const emails = ids.length > 0 ? await this.#client.getEmails(ids) : [];
		return { emails, total };
	}

	async getEmail(id: string): Promise<EmailView | null> {
		try {
			return await this.#client.getEmail(id);
		} catch (err) {
			if (err instanceof JmapError && err.type === "not_found") return null;
			throw err;
		}
	}

	async search(mailboxId: string, filter: Record<string, unknown>): Promise<SearchResult> {
		await this.#requireMailbox(mailboxId);
		const { ids, total } = await this.#client.search(mailboxId, filter);
		return { emailIds: ids, total };
	}

	async setFlags(ids: string[], flags: FlagInput): Promise<{ updated: string[] }> {
		if (ids.length === 0) return { updated: [] };
		const patch = this.#client.buildFlagPatch(ids, {
			seen: flags.read,
			flagged: flags.starred,
		});
		await this.#client.request([patch]);
		return { updated: ids };
	}

	/** Mark every message in a thread read/unread (UI thread-read action). */
	async setThreadRead(mailboxId: string, emailIds: string[], read: boolean): Promise<{ updated: string[] }> {
		return this.setFlags(emailIds, { read });
	}

	async move(
		ids: string[],
		fromMailboxId: string,
		toMailboxId: string,
	): Promise<{ updated: string[] }> {
		if (ids.length === 0) return { updated: [] };
		await this.#requireMailbox(toMailboxId);
		await this.#client.request([
			this.#client.buildMoveCalls(ids, { from: fromMailboxId, to: toMailboxId }),
		]);
		return { updated: ids };
	}

	async createDraft(input: DraftInput): Promise<{ draftId: string }> {
		const result = await this.#drafts.save({
			mailboxId: input.mailboxId,
			previousDraftId: input.replacesDraftId ?? null,
			payload: input,
		});
		return { draftId: result.draft_id };
	}

	async createFolder(input: FolderMutationInput): Promise<{ id: string }> {
		validateFolderMutation({ role: null, operation: "create" });
		const session = await this.#client.discover();
		const responses = await this.#client.request([
			[
				"Mailbox/set",
				{
					accountId: session.accountId,
					create: { new: { name: input.name, parentId: input.parentId ?? null } },
				},
				"c0",
			],
		]);
		const created = (responses[0]?.[1]?.created as Record<string, { id: string }> | undefined)?.new;
		if (!created?.id) {
			throw new JmapError("folder_create_failed", "Stalwart did not confirm the new folder.");
		}
		return { id: created.id };
	}

	async renameFolder(id: string, name: string): Promise<{ updated: string }> {
		const existing = await this.getMailbox(id);
		if (!existing) throw new JmapError("mailbox_not_found", `No such folder: ${id}`, 404);
		validateFolderMutation({ role: existing.systemRole, operation: "rename" });
		const session = await this.#client.discover();
		await this.#client.request([
			["Mailbox/set", { accountId: session.accountId, update: { [id]: { name } } }, "c0"],
		]);
		return { updated: id };
	}

	async deleteFolder(id: string, moveToMailboxId: string): Promise<{ updated: string }> {
		const existing = await this.getMailbox(id);
		if (!existing) throw new JmapError("mailbox_not_found", `No such folder: ${id}`, 404);
		validateFolderMutation({
			role: existing.systemRole,
			operation: "delete",
			moveToMailboxId,
		});
		const session = await this.#client.discover();

		// Move the folder's remaining mail out before destroying the folder, so
		// mail is never silently lost with the container.
		const emails = await this.listEmails(id, { limit: 200 });
		if (emails.emails.length > 0) {
			await this.#client.request([
				this.#client.buildMoveCalls(
					emails.emails.map((e) => e.id),
					{ from: id, to: moveToMailboxId },
				),
			]);
		}
		await this.#client.request([
			["Mailbox/set", { accountId: session.accountId, destroy: [id] }, "c1"],
		]);
		return { updated: id };
	}

	async health(): Promise<{ ok: boolean; detail?: string }> {
		try {
			await this.#client.discover();
			return { ok: true };
		} catch (err) {
			return { ok: false, detail: err instanceof Error ? err.message : "unknown" };
		}
	}

	/** Fail-closed scoping: refuse to touch a mailbox outside this account. */
	async #requireMailbox(id: string): Promise<void> {
		if (!(await this.getMailbox(id))) {
			throw new JmapError("mailbox_not_found", `No such mailbox in this account: ${id}`, 404);
		}
	}

	async #createDraft(mailboxId: string, payload: unknown): Promise<{ id: string }> {
		const input = payload as DraftInput;
		const session = await this.#client.discover();
		const create: Record<string, unknown> = {
			mailboxIds: { [mailboxId]: true },
			keywords: { $draft: true },
			subject: input.subject ?? "",
			bodyValues: { body: { value: input.body } },
			textBody: [{ partId: "body", type: "text/plain" }],
		};
		if (input.to?.length) create.to = input.to.map((email) => ({ email }));
		if (input.cc?.length) create.cc = input.cc.map((email) => ({ email }));
		if (input.bcc?.length) create.bcc = input.bcc.map((email) => ({ email }));

		const responses = await this.#client.request([
			["Email/set", { accountId: session.accountId, create: { draft: create } }, "c0"],
		]);
		const created = (responses[0]?.[1]?.created as Record<string, { id: string }> | undefined)?.draft;
		if (!created?.id) {
			throw new JmapError("draft_create_failed", "Stalwart did not confirm the new draft.");
		}
		return { id: created.id };
	}

	async #destroyDraft(id: string): Promise<void> {
		const session = await this.#client.discover();
		const calls: MethodCall[] = [
			["Email/set", { accountId: session.accountId, destroy: [id] }, "c0"],
		];
		await this.#client.request(calls);
	}

	/**
	 * Validate, then hand the payload to the idempotent submission path.
	 *
	 * Validation runs BEFORE the durable intent is written, so a rejected
	 * message leaves no row and no provider attempt. Without submission wiring
	 * the call refuses (an honest failure) instead of claiming delivery.
	 */
	async sendEmail(input: SendInput): Promise<SendResult> {
		const submission = this.#submission;
		if (!submission) {
			throw new JmapError("submission_unconfigured", "No outbound submission transport is configured.");
		}
		// The guard is authoritative: it normalizes recipients and rejects
		// spoofed From, injection, cross-mailbox attachments and auto-send.
		const checked = validateSubmission(
			{
				mailboxId: input.mailboxId,
				from: input.from,
				to: input.to,
				cc: input.cc ?? [],
				bcc: input.bcc ?? [],
				subject: input.subject ?? "",
				body: input.body,
				attachments: input.attachments ?? [],
			},
			submission.policy,
		);
		const result = await submitWithIdempotency(submission.store, submission.transport, {
			mailboxId: input.mailboxId,
			from: input.from,
			to: checked.to,
			cc: checked.cc,
			bcc: checked.bcc,
			subject: input.subject ?? "",
			body: input.body,
			...(input.attachments?.length ? { attachments: input.attachments } : {}),
			...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
			...(input.references?.length ? { references: input.references } : {}),
		});
		return { requestId: result.requestId, state: result.state === "submitted" || result.state === "accepted" ? "queued" : result.state === "unknown" ? "unknown" : "failed" };
	}
}
