// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: operator-only setup workflow and validated app settings.
//
// Provisioning is intentionally a local operator action (CLI), not a browser
// route. It both records the mailbox in the journal and (in later phases)
// proves the corresponding Stalwart account before the address is enabled.

import type { Journal } from "../db/index";
import { isValidAddress, MailboxRegistry, normalizeAddress, RegistryError } from "./registry";

export interface AppSettings {
	/** Public UI hostname, if a tunnel route is published. Informational only. */
	publicHostname: string | null;
	/** Mailbox address that receives unknown-address quarantine policy mail. */
	quarantineMailboxId: string | null;
	/** Bounded cap on quarantined messages before the owner is alerted. */
	quarantineLimit: number;
	/** Incoming poll interval in seconds. Never below 30 in production. */
	pollIntervalSeconds: number;
	/** Total spool budget in bytes for in-flight raw MIME. */
	spoolLimitBytes: number;
	/** Bounded page size for provider received-email listing. */
	providerPageSize: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
	publicHostname: null,
	quarantineMailboxId: null,
	quarantineLimit: 200,
	pollIntervalSeconds: 60,
	spoolLimitBytes: 512 * 1024 * 1024,
	providerPageSize: 50,
};

const SETTINGS_KEY = "app_settings";


function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RegistryError("invalid_settings", "Settings must be a JSON object.");
	}
	return value as Record<string, unknown>;
}

/**
 * Validate settings field by field. Unknown keys are dropped rather than
 * silently persisted, and every bound is enforced here so no caller can write
 * an unsafe poll interval or unlimited spool.
 */
export function validateSettings(value: unknown): AppSettings {
	const raw = asRecord(value);
	const out: AppSettings = { ...DEFAULT_SETTINGS };

	if (raw.publicHostname !== undefined && raw.publicHostname !== null) {
		if (typeof raw.publicHostname !== "string" || raw.publicHostname.length === 0) {
			throw new RegistryError("invalid_settings", "publicHostname must be a non-empty string or null.");
		}
		out.publicHostname = raw.publicHostname;
	}

	if (raw.quarantineMailboxId !== undefined && raw.quarantineMailboxId !== null) {
		if (typeof raw.quarantineMailboxId !== "string" || raw.quarantineMailboxId.length === 0) {
			throw new RegistryError("invalid_settings", "quarantineMailboxId must be a non-empty string or null.");
		}
		out.quarantineMailboxId = raw.quarantineMailboxId;
	}

	if (raw.quarantineLimit !== undefined) {
		const n = raw.quarantineLimit;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 100_000) {
			throw new RegistryError("invalid_settings", "quarantineLimit must be an integer between 1 and 100000.");
		}
		out.quarantineLimit = n;
	}

	if (raw.pollIntervalSeconds !== undefined) {
		const n = raw.pollIntervalSeconds;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 30 || n > 86_400) {
			throw new RegistryError(
				"invalid_settings",
				"pollIntervalSeconds must be an integer between 30 and 86400 (provider quota protection).",
			);
		}
		out.pollIntervalSeconds = n;
	}

	if (raw.spoolLimitBytes !== undefined) {
		const n = raw.spoolLimitBytes;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 1024 * 1024 || n > 8 * 1024 ** 3) {
			throw new RegistryError("invalid_settings", "spoolLimitBytes must be between 1 MiB and 8 GiB.");
		}
		out.spoolLimitBytes = n;
	}

	if (raw.providerPageSize !== undefined) {
		const n = raw.providerPageSize;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 100) {
			throw new RegistryError("invalid_settings", "providerPageSize must be an integer between 1 and 100.");
		}
		out.providerPageSize = n;
	}

	return out;
}

export class SettingsStore {
	#db: Journal;

	constructor(db: Journal) {
		this.#db = db;
	}

	read(): AppSettings {
		const row = this.#db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY) as
			| { value: string }
			| undefined;
		if (!row) return { ...DEFAULT_SETTINGS };
		try {
			return validateSettings(JSON.parse(row.value));
		} catch {
			throw new RegistryError("invalid_settings", "Stored settings are invalid; operator repair is required.");
		}
	}

	write(value: unknown): AppSettings {
		return this.#db.transaction(() => {
			const validated = validateSettings({ ...this.read(), ...asRecord(value) });
			this.#db
				.prepare(
					"INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.run(SETTINGS_KEY, JSON.stringify(validated));
			return validated;
		}).immediate();
	}
}

export interface SetupOptions {
	db: Journal;
	registry?: MailboxRegistry;
}

/**
 * Operator-only: provision an address and optionally bind its proven JMAP
 * account. Never exposes a path that creates a Stalwart user from the browser.
 */
export function provisionMailbox(
	opts: SetupOptions,
	input: { id: string; address: string; displayName?: string; jmapAccountId?: string | null; enable?: boolean },
): ReturnType<MailboxRegistry["provision"]> {
	if (input.enable !== undefined && typeof input.enable !== "boolean") {
		throw new RegistryError("invalid_enabled", "Mailbox activation must be a boolean.");
	}
	const registry = opts.registry ?? new MailboxRegistry(opts.db);
	if (!registry.isBackedBy(opts.db)) {
		throw new RegistryError("wrong_journal", "Setup registry and transaction must use the same journal connection.");
	}
	return opts.db.transaction(() => {
		if (!isValidAddress(input.address)) {
			throw new RegistryError("invalid_address", `Refusing to provision invalid address: ${input.address}`);
		}
		const rec = registry.provision({
			id: input.id,
			address: normalizeAddress(input.address),
			displayName: input.displayName,
			jmapAccountId: input.jmapAccountId ?? null,
		});
		if (input.jmapAccountId) registry.bindAccount(rec.id, input.jmapAccountId);
		if (input.enable === true) return registry.setEnabled(rec.id, true);
		return registry.getById(rec.id)!;
	}).immediate();
}
