// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 8: safe draft creation/replacement.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { DraftStore } from "../../server/mail/drafts";

/** Minimal in-memory JMAP stand-in that can be made to fail on demand. */
function makeJmap(overrides: { failCreate?: boolean; failDestroy?: boolean } = {}) {
	let counter = 0;
	const created: string[] = [];
	const destroyed: string[] = [];
	return {
		created,
		destroyed,
		async createDraft(_mailboxId: string, _payload: unknown) {
			if (overrides.failCreate) throw new Error("create failed");
			counter += 1;
			const id = `draft-${counter}`;
			created.push(id);
			return { id };
		},
		async destroyDraft(id: string) {
			if (overrides.failDestroy) throw new Error("destroy failed");
			destroyed.push(id);
		},
	};
}

describe("draft replacement", () => {
	test("returns the draft_id key the UI client actually consumes", async () => {
		const jmap = makeJmap();
		const store = new DraftStore(jmap as never);
		const result = await store.save({ mailboxId: "mb-drafts", previousDraftId: null, payload: {} });
		expect(result).toHaveProperty("draft_id");
		expect(result.draft_id).toBe("draft-1");
		// Upstream returned `id`; the adapter must not regress to that.
		expect(result).not.toHaveProperty("id");
	});

	test("preserves the previous draft when the replacement fails", async () => {
		const jmap = makeJmap({ failCreate: true });
		const store = new DraftStore(jmap as never);
		await expect(store.save({ mailboxId: "mb-drafts", previousDraftId: "old-1", payload: {} })).rejects.toThrow(
			/create failed/,
		);
		// The old draft must NOT have been destroyed.
		expect(jmap.destroyed).toEqual([]);
	});

	test("destroys the previous draft only after the new one exists", async () => {
		const jmap = makeJmap();
		const store = new DraftStore(jmap as never);
		await store.save({ mailboxId: "mb-drafts", previousDraftId: "old-1", payload: {} });
		expect(jmap.created).toEqual(["draft-1"]);
		expect(jmap.destroyed).toEqual(["old-1"]);
	});

	test("a failed destroy does not lose the new draft", async () => {
		const jmap = makeJmap({ failDestroy: true });
		const store = new DraftStore(jmap as never);
		const result = await store.save({ mailboxId: "mb-drafts", previousDraftId: "old-1", payload: {} });
		expect(result.draft_id).toBe("draft-1");
		expect(result.warnings[0]).toMatch(/previous draft/i);
	});

	test("retrying a failed save does not create duplicate visible drafts", async () => {
		const jmap = makeJmap({ failCreate: true });
		const store = new DraftStore(jmap as never);
		const spy = vi.spyOn(jmap, "createDraft");
		await expect(
			store.save({ mailboxId: "mb-drafts", previousDraftId: null, payload: {}, idempotencyKey: "k-1" }),
		).rejects.toThrow();
		await expect(
			store.save({ mailboxId: "mb-drafts", previousDraftId: null, payload: {}, idempotencyKey: "k-1" }),
		).rejects.toThrow();
		// Two attempts, zero committed drafts.
		expect(spy).toHaveBeenCalledTimes(2);
		expect(jmap.created).toEqual([]);
	});

	test("saving without a mailbox is refused before any JMAP write", async () => {
		const jmap = makeJmap();
		const store = new DraftStore(jmap as never);
		const spy = vi.spyOn(jmap, "createDraft");
		await expect(store.save({ mailboxId: "", previousDraftId: null, payload: {} })).rejects.toThrow(/mailbox/i);
		expect(spy).not.toHaveBeenCalled();
	});
});
