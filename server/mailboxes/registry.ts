// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: mailbox/address registry.
//
// Only operator-provisioned addresses become sendable mailboxes. The browser
// may activate a provisioned address but can never invent a sender domain or
// freely create a Stalwart account.

import type { Journal, MailboxRecord } from "../db/index";

export interface MailboxInput {
	id: string;
	address: string;
	displayName?: string;
	jmapAccountId?: string | null;
}

export class RegistryError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "RegistryError";
	}
}

const ADDRESS_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

export function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

export function isValidAddress(address: string): boolean {
	return ADDRESS_RE.test(address.trim());
}

/**
 * Operator-only provisioning. This is the single place a new sendable
 * identity can appear; it is not reachable from the browser.
 */
export class MailboxRegistry {
	#db: Journal;

	constructor(db: Journal) {
		this.#db = db;
	}

	/** Register an operator-provisioned address. Idempotent per address. */
	provision(input: MailboxInput): MailboxRecord {
		if (!isValidAddress(input.address)) {
			throw new RegistryError("invalid_address", `Not a valid mailbox address: ${input.address}`);
		}
		const address = normalizeAddress(input.address);
		const existing = this.#db
			.prepare("SELECT * FROM mailboxes WHERE address = ?")
			.get(address) as MailboxRecord | undefined;
		if (existing) return existing;

		this.#db
			.prepare(
				`INSERT INTO mailboxes (id, address, display_name, jmap_account_id, enabled, created_at)
				 VALUES (?, ?, ?, ?, 0, ?)`,
			)
			.run(input.id, address, input.displayName ?? "", input.jmapAccountId ?? null, new Date().toISOString());
		return this.getById(input.id)!;
	}

	/** Operator toggles the enabled flag after the Stalwart account is proven. */
	setEnabled(id: string, enabled: boolean): MailboxRecord {
		const rec = this.getById(id);
		if (!rec) throw new RegistryError("not_found", `No such mailbox: ${id}`);
		if (enabled && !rec.jmap_account_id) {
			throw new RegistryError(
				"unproven_account",
				"Refusing to enable a mailbox with no proven JMAP account binding.",
			);
		}
		this.#db.prepare("UPDATE mailboxes SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
		return this.getById(id)!;
	}

	bindAccount(id: string, jmapAccountId: string): MailboxRecord {
		const rec = this.getById(id);
		if (!rec) throw new RegistryError("not_found", `No such mailbox: ${id}`);
		this.#db.prepare("UPDATE mailboxes SET jmap_account_id = ? WHERE id = ?").run(jmapAccountId, id);
		return this.getById(id)!;
	}

	setDisplayName(id: string, displayName: string): MailboxRecord {
		const rec = this.getById(id);
		if (!rec) throw new RegistryError("not_found", `No such mailbox: ${id}`);
		this.#db.prepare("UPDATE mailboxes SET display_name = ? WHERE id = ?").run(displayName, id);
		return this.getById(id)!;
	}

	getById(id: string): MailboxRecord | undefined {
		return this.#db.prepare("SELECT * FROM mailboxes WHERE id = ?").get(id) as MailboxRecord | undefined;
	}

	getByAddress(address: string): MailboxRecord | undefined {
		return this.#db.prepare("SELECT * FROM mailboxes WHERE address = ?").get(normalizeAddress(address)) as
			| MailboxRecord
			| undefined;
	}

	/** Every provisioned mailbox, enabled or not (operator view). */
	listAll(): MailboxRecord[] {
		return this.#db.prepare("SELECT * FROM mailboxes ORDER BY address").all() as MailboxRecord[];
	}

	/** Only enabled mailboxes may appear as sendable in the UI. */
	listEnabled(): MailboxRecord[] {
		return this.#db.prepare("SELECT * FROM mailboxes WHERE enabled = 1 ORDER BY address").all() as MailboxRecord[];
	}

	/**
	 * Non-destructive unlink. Canonical mail stays in Stalwart unless a
	 * separate destructive purge is explicitly approved.
	 */
	unlink(id: string): MailboxRecord {
		const rec = this.getById(id);
		if (!rec) throw new RegistryError("not_found", `No such mailbox: ${id}`);
		this.#db.prepare("UPDATE mailboxes SET enabled = 0 WHERE id = ?").run(id);
		return this.getById(id)!;
	}
}

/**
 * Destructive account deletion is deliberately absent. Any future purge must
 * be an explicit operator action that first proves canonical-data preservation
 * or obtains separate approval.
 */
export function deleteMailbox(): never {
	throw new RegistryError(
		"deletion_disabled",
		"Browser-driven mailbox deletion is disabled; use an operator unlink/purge workflow.",
	);
}
