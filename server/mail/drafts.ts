// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: safe draft persistence.
//
// Ordering matters here. A draft replacement creates the new draft first and
// only destroys the previous one after the new one is confirmed to exist. If
// creation fails, the previous draft is left untouched so no user work is lost.
//
// The response key is `draft_id`: upstream's typed client expects that, while
// the upstream Worker route returned `id`. The adapter emits the contract the
// UI consumes.

export class DraftError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "DraftError";
	}
}

export interface DraftJmapPort {
	createDraft(mailboxId: string, payload: unknown): Promise<{ id: string }>;
	destroyDraft(id: string): Promise<void>;
}

export interface SaveDraftInput {
	mailboxId: string;
	previousDraftId: string | null;
	payload: unknown;
	/** Optional stable key so a retried save is recognisable. */
	idempotencyKey?: string;
}

export interface SaveDraftResult {
	draft_id: string;
	/** Non-fatal problems, e.g. the old draft could not be removed. */
	warnings: string[];
}

export class DraftStore {
	#jmap: DraftJmapPort;

	constructor(jmap: DraftJmapPort) {
		this.#jmap = jmap;
	}

	async save(input: SaveDraftInput): Promise<SaveDraftResult> {
		if (!input.mailboxId) {
			throw new DraftError("missing_mailbox", "A draft must be saved into a specific mailbox.");
		}

		// 1. Create the replacement. If this throws, nothing has been destroyed.
		const created = await this.#jmap.createDraft(input.mailboxId, input.payload);
		const warnings: string[] = [];

		// 2. Only now is it safe to remove the previous draft.
		if (input.previousDraftId && input.previousDraftId !== created.id) {
			try {
				await this.#jmap.destroyDraft(input.previousDraftId);
			} catch {
				// The new draft survives; the stale one is reported, not hidden.
				warnings.push(`Could not remove previous draft ${input.previousDraftId}; it remains visible.`);
			}
		}

		return { draft_id: created.id, warnings };
	}
}
