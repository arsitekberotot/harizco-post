// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: JMAP implementation of the import port.
//
// Uploads raw MIME as a blob, imports it into the target mailbox, and proves the
// canonical copy by readback. A message is only ever reported verified after
// this readback matches, so a partial or mis-addressed import cannot masquerade
// as success.

import { JmapClient, JmapError, type JmapClientOptions } from "../mail/jmap-client";
import type { JmapImportPort } from "./import";

export interface JmapImportOptions extends JmapClientOptions {
	/** Account used for all imports performed by this port. */
	accountId?: string;
	/** Mailbox keyword applied to imported mail (defaults to none). */
	keywords?: Record<string, true>;
}

export class JmapImportAdapter implements JmapImportPort {
	readonly #client: JmapClient;
	readonly #explicitAccountId: string | undefined;
	readonly #keywords: Record<string, true>;

	constructor(opts: JmapImportOptions) {
		this.#client = new JmapClient(opts);
		this.#explicitAccountId = opts.accountId;
		this.#keywords = opts.keywords ?? {};
	}

	async #accountId(): Promise<string> {
		if (this.#explicitAccountId) return this.#explicitAccountId;
		const session = await this.#client.discover();
		return session.accountId;
	}

	async upload(bytes: Uint8Array): Promise<string> {
		const session = await this.#client.discover();
		const uploadUrl = session.uploadUrl.replace("{accountId}", encodeURIComponent(session.accountId));
		const res = await fetch(uploadUrl, {
			method: "POST",
			headers: {
				"Content-Type": "message/rfc822",
				...this.#client.authHeaders(),
			},
			// undici accepts a Uint8Array body at runtime; the DOM lib's BodyInit
			// type does not model it, so cast at this single boundary.
			body: bytes as unknown as RequestInit["body"],
		});
		if (!res.ok) {
			throw new JmapError("upload_failed", `Blob upload failed with ${res.status}.`, res.status);
		}
		const body = (await res.json()) as { blobId?: string };
		if (!body.blobId) {
			throw new JmapError("upload_failed", "Blob upload did not return a blobId.");
		}
		return body.blobId;
	}

	async importEmail(input: { mailboxId: string; blobId: string; bytes: Uint8Array }): Promise<{ emailId: string }> {
		void input.bytes;
		const accountId = await this.#accountId();
		const responses = await this.#client.request([
			[
				"Email/import",
				{
					accountId,
					emails: {
						imported: {
							blobId: input.blobId,
							mailboxIds: { [input.mailboxId]: true },
							keywords: this.#keywords,
						},
					},
				},
				"c0",
			],
		]);
		const created = (responses[0]?.[1]?.created as Record<string, { id: string }> | undefined)?.imported;
		if (!created?.id) {
			const notCreated = responses[0]?.[1]?.notCreated as Record<string, { description?: string }> | undefined;
			const detail = notCreated?.imported?.description ?? "Stalwart did not confirm the import.";
			throw new JmapError("import_failed", detail);
		}
		return { emailId: created.id };
	}

	async readback(emailId: string): Promise<{ emailId: string; blobId: string; size: number } | null> {
		const accountId = await this.#accountId();
		const responses = await this.#client.request([
			["Email/get", { accountId, ids: [emailId], properties: ["id", "blobId", "size"] }, "c0"],
		]);
		const list = (responses[0]?.[1]?.list as { id: string; blobId?: string; size?: number }[] | undefined) ?? [];
		const found = list.find((e) => e.id === emailId);
		if (!found?.blobId || typeof found.size !== "number") return null;
		return { emailId: found.id, blobId: found.blobId, size: found.size };
	}

	async findByContentHash(_hash: string): Promise<{ emailId: string; blobId: string } | null> {
		// Stalwart exposes no server-side content-hash index, so idempotency is
		// enforced by the journal (provider receipt id + content hash), not here.
		// Returning null keeps the pipeline honest: it never claims a message is
		// already present without the journal's own record.
		void _hash;
		return null;
	}
}
