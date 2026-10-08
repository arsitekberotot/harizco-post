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

function validBinding(value: unknown): value is string {
	return typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

export function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

export function isValidAddress(address: string): boolean {
	return typeof address === "string" && !/[\x00-\x1f\x7f]/.test(address) && ADDRESS_RE.test(address.trim());
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

	/** Setup's transaction must cover this exact connection, not just a path. */
	isBackedBy(db: Journal): boolean {
		return this.#db === db;
	}

	/** Register an operator-provisioned address. Idempotent per address. */
	provision(input: MailboxInput): MailboxRecord {
		if (typeof input.id !== "string" || !input.id.trim() || /[\x00-\x1f\x7f]/.test(input.id)) {
			throw new RegistryError("invalid_id", "A nonempty mailbox identity is required.");
		}
		if (input.jmapAccountId !== undefined && input.jmapAccountId !== null && !validBinding(input.jmapAccountId)) {
			throw new RegistryError("invalid_account", "A nonempty JMAP account binding is required.");
		}
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
				 VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(address) DO NOTHING`,
			)
			.run(input.id, address, input.displayName ?? "", input.jmapAccountId ?? null, new Date().toISOString());
		return this.getByAddress(address)!;
	}

	/** Operator toggles the enabled flag after the Stalwart account is proven. */
	setEnabled(id: string, enabled: boolean): MailboxRecord {
		if (typeof enabled !== "boolean") throw new RegistryError("invalid_enabled", "Mailbox activation must be a boolean.");
		const rec = this.getById(id);
		if (!rec) throw new RegistryError("not_found", `No such mailbox: ${id}`);
		if (enabled && !validBinding(rec.jmap_account_id)) {
			throw new RegistryError(
				"unproven_account",
				"Refusing to enable a mailbox with no proven JMAP account binding.",
			);
		}
		this.#db.prepare("UPDATE mailboxes SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
		return this.getById(id)!;
	}

	/** Browser-safe registry action: never provision a new address or account. */
	activateByAddress(address: string): MailboxRecord {
		if (!isValidAddress(address)) throw new RegistryError("invalid_address", "A valid configured address is required.");
		const rec = this.getByAddress(address);
		if (!rec) throw new RegistryError("not_provisioned", "Only operator-provisioned addresses may be activated.");
		return this.setEnabled(rec.id, true);
	}

	bindAccount(id: string, jmapAccountId: string): MailboxRecord {
		const rec = this.getById(id);
		if (!rec) throw new RegistryError("not_found", `No such mailbox: ${id}`);
		if (!validBinding(jmapAccountId)) {
			throw new RegistryError("invalid_account", "A nonempty JMAP account binding is required.");
		}
		if (rec.jmap_account_id && rec.jmap_account_id !== jmapAccountId) {
			throw new RegistryError("account_rebind_forbidden", "Changing a canonical account binding requires a separately approved migration.");
		}
		const changed = this.#db.prepare(`UPDATE mailboxes SET jmap_account_id = ?
			WHERE id = ? AND (jmap_account_id IS NULL OR jmap_account_id = ?)`)
			.run(jmapAccountId, id, jmapAccountId).changes;
		if (changed !== 1) {
			throw new RegistryError("account_rebind_forbidden", "Canonical account binding changed; refusing a stale update.");
		}
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
		const records = this.#db.prepare("SELECT * FROM mailboxes WHERE enabled = 1 ORDER BY address").all() as MailboxRecord[];
		return records.filter(rec => isValidAddress(rec.address) && validBinding(rec.jmap_account_id));
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
