// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: in-memory attachment METADATA helper, not an HTTP route.
// No byte storage, persistence, upload/download, reference transition, draft or
// submission integration exists here. Size checks trust caller metadata and
// do not prove a bounded upload/readback. Ownership checks apply to this map
// only. The actual authorized parent-message CID fetch remains to be wired.

import { sanitizeFilename } from "../../shared/sanitize-html";

// Re-export the shared security helpers so callers can import them from the
// route module, while the implementation stays single-sourced for the client.
export { sanitizeFilename };

/** Raised for any attachment operation that must be refused. */
export class AttachmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AttachmentError";
	}
}

export interface AttachmentInput {
	mailboxId: string;
	filename: string;
	contentType: string;
	/** Size in bytes. */
	bytes: number;
	/** Content id for inline images (optional). */
	cid?: string;
	/** A temporary upload has no draft/submission reference yet. */
	temporary?: boolean;
}

export interface StoredAttachment {
	id: string;
	mailboxId: string;
	filename: string;
	contentType: string;
	bytes: number;
	cid?: string;
	temporary: boolean;
	createdAt: number;
}

/**
 * Build a Content-Disposition that is always `attachment` and never injectable.
 */
export function safeContentDisposition(filename: string): string {
	const safe = sanitizeFilename(filename);
	// ASCII fallback for the plain filename parameter.
	const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
	const parts = [`filename="${ascii}"`];
	// RFC 5987 filename* for non-ASCII names.
	if (/[^\x20-\x7e]/.test(safe)) {
		const encoded = encodeURIComponent(safe).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
		parts.push(`filename*=UTF-8''${encoded}`);
	}
	return `attachment; ${parts.join("; ")}`;
}

export interface AttachmentStore {
	put(input: AttachmentInput): StoredAttachment;
	/** Read an attachment ONLY if the mailbox owns it. */
	get(mailboxId: string, id: string): StoredAttachment | null;
	/** Assert ownership or throw; used before referencing a blob in a draft/send. */
	assertOwned(mailboxId: string, id: string): StoredAttachment;
	/** Reap temporary uploads older than the TTL. Returns how many were removed. */
	reapTemporary(): number;
}

export interface AttachmentStoreOptions {
	maxBytes: number;
	tempTtlMs: number;
	clock?: () => number;
}

/** In-memory store. The journal/blob layer is wired in a later task. */
export function createAttachmentStore(options: AttachmentStoreOptions): AttachmentStore {
	const { maxBytes, tempTtlMs, clock = () => Date.now() } = options;
	const byId = new Map<string, StoredAttachment>();
	let seq = 0;

	return {
		put(input: AttachmentInput): StoredAttachment {
			if (!Number.isFinite(input.bytes) || input.bytes < 0) {
				throw new AttachmentError("Attachment size is invalid");
			}
			if (input.bytes > maxBytes) {
				throw new AttachmentError(`Attachment too large: ${input.bytes} exceeds ${maxBytes} bytes`);
			}
			const id = `att_${++seq}`;
			const record: StoredAttachment = {
				id,
				mailboxId: input.mailboxId,
				filename: sanitizeFilename(input.filename),
				contentType: input.contentType || "application/octet-stream",
				bytes: input.bytes,
				cid: input.cid,
				temporary: input.temporary ?? false,
				createdAt: clock(),
			};
			byId.set(id, record);
			return record;
		},

		get(mailboxId: string, id: string): StoredAttachment | null {
			const rec = byId.get(id);
			if (!rec) return null;
			// Ownership is part of identity: a non-owner sees nothing.
			return rec.mailboxId === mailboxId ? rec : null;
		},

		assertOwned(mailboxId: string, id: string): StoredAttachment {
			const rec = byId.get(id);
			if (!rec) throw new AttachmentError("Attachment not found");
			if (rec.mailboxId !== mailboxId) {
				throw new AttachmentError("Attachment is not owned by this mailbox");
			}
			return rec;
		},

		reapTemporary(): number {
			const now = clock();
			let removed = 0;
			for (const [id, rec] of byId) {
				if (rec.temporary && now - rec.createdAt >= tempTtlMs) {
					byId.delete(id);
					removed += 1;
				}
			}
			return removed;
		},
	};
}

