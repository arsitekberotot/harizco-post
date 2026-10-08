// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: local Node runtime configuration.
//
// Loopback-only. Production requires a validated Access owner configuration
// and canonical public browser origin. Environment flags never enable auth bypass.

import { parseAccessConfig, parsePublicOrigin } from "./auth/configuration";

/** Cloudflare Access identity assumptions required for production start. */
export interface AppAccessConfig {
	readonly teamDomain: string;
	readonly policyAud: string;
	readonly ownerEmail: string;
}

export interface AppConfig {
	/** Always `127.0.0.1`; never configurable to a public interface. */
	readonly host: "127.0.0.1";
	readonly port: number;
	readonly nodeEnv: string;
	readonly isProduction: boolean;
	/** Canonical HTTPS browser origin, distinct from loopback HTTP transport. */
	readonly publicOrigin?: string;
	/**
	 * Present only when a complete, valid Access configuration was supplied.
	 * Absent means every private request is denied (fail closed).
	 */
	readonly access?: AppAccessConfig;
	/**
	 * Optional private mailbox binding. Null means no mail backend is wired, so
	 * authenticated reads must return an honest 503 rather than fabricate data.
	 */
	readonly mailbox: MailboxBinding | null;
}

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Env flags that would otherwise request a development authentication bypass. */
const BYPASS_FLAGS = [
	"FIXTURE_AUTH_BYPASS",
	"ALLOW_FIXTURE_AUTH",
	"DEV_AUTH_BYPASS",
	"AUTH_BYPASS",
] as const;

function isTruthy(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

function parsePort(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
	if (!/^\d+$/.test(raw.trim())) {
		throw new Error("Invalid PORT: expected an integer 1-65535");
	}
	const port = Number.parseInt(raw.trim(), 10);
	if (port < MIN_PORT || port > MAX_PORT) {
		throw new Error("Invalid PORT: expected an integer 1-65535");
	}
	return port;
}

/**
 * Build the runtime config from a process-like env map.
 *
 * @throws when a non-loopback host is requested, the port is invalid, or the
 * environment is production without complete Access configuration.
 */
export function loadConfig(env: Record<string, string | undefined> = {}): AppConfig {
	const nodeEnv = (env.NODE_ENV ?? "development").trim() || "development";
	const isProduction = nodeEnv === "production";

	// The service only ever listens on loopback; a tunnel terminates in front
	// of it. Anything else is a misconfiguration, not a feature toggle.
	const requestedHost = (env.HOST ?? env.BIND_HOST ?? "").trim();
	if (requestedHost !== "" && requestedHost !== LOOPBACK_HOST) {
		throw new Error(
			`Invalid HOST: Harizco Post only binds the loopback address ${LOOPBACK_HOST}`,
		);
	}

	const port = parsePort(env.PORT);

	const requestedBypasses = BYPASS_FLAGS.filter((flag) => isTruthy(env[flag]));

	if (isProduction && requestedBypasses.length > 0) {
		throw new Error("Refusing to start in production with authentication bypass flags");
	}
	const teamDomain = env.TEAM_DOMAIN ?? "";
	const policyAud = env.POLICY_AUD ?? "";
	const ownerEmail = env.OWNER_EMAIL ?? "";
	const anyAccess = teamDomain !== "" || policyAud !== "" || ownerEmail !== "";
	const access = anyAccess || isProduction ? parseAccessConfig(teamDomain, policyAud, ownerEmail) : undefined;
	const rawOrigin = env.PUBLIC_ORIGIN ?? "";
	const publicOrigin = rawOrigin !== "" || isProduction ? parsePublicOrigin(rawOrigin) : undefined;

	return {
		host: LOOPBACK_HOST,
		port,
		nodeEnv,
		isProduction,
		...(publicOrigin ? { publicOrigin } : {}),
		...(access ? { access } : {}),
		mailbox: loadMailboxBinding(env),
	};
}

export { LOOPBACK_HOST, DEFAULT_PORT, BYPASS_FLAGS };

// ---------------------------------------------------------------------------
// Sync worker configuration
// ---------------------------------------------------------------------------

/**
 * Configuration owned by the sync worker only.
 *
 * The web process never loads this: Resend and Stalwart credentials live with
 * the worker that needs them, so a web compromise cannot read mail secrets.
 */
export interface SyncConfig {
	/** SQLite integration journal path. */
	dbPath: string;
	/** Directory the raw-MIME spool owns. */
	spoolDir: string;
	/** Resend receiving API key. */
	resendApiKey: string;
	/** Resend API base URL (defaulted). */
	resendBaseUrl: string;
	/** Provider label recorded in the journal. */
	provider: string;
	/** Seconds between polls. */
	intervalSeconds: number;
	/** Stalwart JMAP endpoint. */
	stalwartUrl: string;
	/** Stalwart JMAP username. */
	stalwartUsername: string;
	/** Stalwart JMAP secret. */
	stalwartSecret: string;
	/** Account the worker imports into; discovered when absent. */
	stalwartAccountId?: string;
}

const DEFAULT_INTERVAL_SECONDS = 60;
/** Web-process mailbox binding (private JMAP read path). */
export interface MailboxBinding {
	/** JMAP endpoint reachable from the web process (loopback Stalwart). */
	readonly url: string;
	/** JMAP username. */
	readonly username: string;
	/** JMAP secret; never logged. */
	readonly secret: string;
	/** Account to bind; discovered from the session when absent. */
	readonly accountId?: string;
}

/**
 * Load the optional web mailbox binding.
 *
 * Returns null when unset so an authenticated read keeps its honest 503
 * instead of the server fabricating mail. Throws when the binding is partially
 * configured: a half-set credential must refuse to start, not silently degrade.
 */
export function loadMailboxBinding(env: Record<string, string | undefined> = {}): MailboxBinding | null {
	const raw = {
		url: env.STALWART_URL?.trim() ?? "",
		username: env.STALWART_USERNAME?.trim() ?? "",
		secret: env.STALWART_SECRET?.trim() ?? "",
		accountId: env.STALWART_ACCOUNT_ID?.trim() ?? "",
	};
	const present = [raw.url, raw.username, raw.secret].filter(Boolean);
	if (present.length === 0) return null;
	for (const [key, value] of [["STALWART_URL", raw.url], ["STALWART_USERNAME", raw.username], ["STALWART_SECRET", raw.secret]] as const) {
		if (!value) throw new Error(`Incomplete mailbox binding: ${key} is required when any STALWART_* mailbox variable is set`);
	}
	if (!/^https?:\/\//.test(raw.url)) throw new Error(`Invalid STALWART_URL: expected an http(s) URL, received a non-URL value`);
	return {
		url: raw.url.replace(/\/$/, ""),
		username: raw.username,
		secret: raw.secret,
		...(raw.accountId ? { accountId: raw.accountId } : {}),
	};
}

// The runner refuses intervals below 30s to respect provider rate limits, so
// the config floor matches rather than accepting a value the runner rejects.
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 3600;

/**
 * Web-process outbound submission binding.
 *
 * Presence of ANY of these variables turns on the real send path: the web
 * process records the durable intent and hands the payload to
 * `OUTBOUND_RELAY_URL` (the worker's relay), which holds the provider secret.
 * Absent, `sendEmail` refuses rather than claiming a message was sent.
 */
export interface OutboundBinding {
	/** SQLite journal the submission intents are recorded in. */
	readonly dbPath: string;
	/** Owned sender address every From must match. */
	readonly address: string;
	/** All operator-configured addresses on this owned domain. */
	readonly addresses: readonly string[];
	/** Owned domain every From must be on (defaults from the address). */
	readonly domain: string;
	/** Max total recipients across To+Cc+Bcc. */
	readonly maxRecipients: number;
	/** Max message size in bytes. */
	readonly maxBytes: number;
	/** Provider the worker relays through (label only in the web process). */
	readonly relayUrl: string;
}

const DEFAULT_MAX_RECIPIENTS = 20;
const DEFAULT_MAX_BYTES = 5_000_000;
const OUTBOUND_ADDRESS_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/**
 * Load the optional outbound submission binding.
 *
 * Returns null when unset (honest refusal on send) and throws when partially
 * configured — a half-set sender identity must refuse to start rather than
 * silently send From the wrong address.
 */
export function loadOutboundBinding(env: Record<string, string | undefined> = {}): OutboundBinding | null {
	const rawAddress = (env.OUTBOUND_FROM ?? "").trim();
	const relayUrl = (env.OUTBOUND_RELAY_URL ?? "").trim();
	if (!rawAddress && !relayUrl) return null;
	if (!rawAddress || !relayUrl) {
		throw new Error("Incomplete outbound binding: OUTBOUND_FROM and OUTBOUND_RELAY_URL must both be set");
	}
	const address = rawAddress.toLowerCase();
	if (!OUTBOUND_ADDRESS_RE.test(address)) throw new Error("Invalid OUTBOUND_FROM: expected a single email address");
	if (!/^https?:\/\//.test(relayUrl)) throw new Error("Invalid OUTBOUND_RELAY_URL: expected an http(s) URL");
	const domain = (env.OUTBOUND_DOMAIN ?? address.split("@")[1] ?? "").trim().toLowerCase();
	const rawAddresses = env.OUTBOUND_ADDRESSES;
	const addresses = rawAddresses === undefined
		? [address]
		: rawAddresses.split(",").map((item) => item.trim().toLowerCase());
	if (
		addresses.length === 0 ||
		addresses.some((item) => !OUTBOUND_ADDRESS_RE.test(item) || item.split("@")[1] !== domain) ||
		new Set(addresses).size !== addresses.length ||
		!addresses.includes(address)
	) {
		throw new Error("Invalid OUTBOUND_ADDRESSES: expected unique addresses on the owned domain, including OUTBOUND_FROM");
	}
	return {
		dbPath: (env.SYNC_DB_PATH ?? env.DB_PATH ?? "var/harizco-post.sqlite").trim(),
		address,
		addresses,
		domain,
		maxRecipients: intOrDefault(env.OUTBOUND_MAX_RECIPIENTS, DEFAULT_MAX_RECIPIENTS),
		maxBytes: intOrDefault(env.OUTBOUND_MAX_BYTES, DEFAULT_MAX_BYTES),
		relayUrl: relayUrl.replace(/\/$/, ""),
	};
}

function intOrDefault(raw: string | undefined, fallback: number): number {
	const value = (raw ?? "").trim();
	if (value === "") return fallback;
	if (!/^\d+$/.test(value)) throw new Error(`Expected a positive integer, received "${raw}"`);
	return Number.parseInt(value, 10);
}

/**
 * Worker-side relay listener binding.
 *
 * The relay endpoint owns the provider secret, so it runs in the worker, not
 * the web process. It binds loopback-only: the web process reaches it over
 * 127.0.0.1, and nothing public is ever exposed.
 */
export interface RelayBinding {
	/** Loopback host to bind. */
	readonly host: string;
	readonly port: number;
	/** Shared secret the web process presents; never logged. */
	readonly secret: string;
	/** Resend API key used to actually send. */
	readonly apiKey: string;
	readonly baseUrl: string;
}

/**
 * Load the optional relay binding.
 *
 * Returns null when unset (no relay listener). Throws when partially
 * configured — a relay without a secret would be an open send path, so a
 * half-set binding must refuse to start.
 */
export function loadRelayBinding(env: Record<string, string | undefined> = {}): RelayBinding | null {
	const secret = (env.RELAY_SHARED_SECRET ?? "").trim();
	const apiKey = (env.RELAY_RESEND_API_KEY ?? "").trim();
	if (!secret && !apiKey) return null;
	if (!secret || !apiKey) {
		throw new Error("Incomplete relay binding: RELAY_SHARED_SECRET and RELAY_RESEND_API_KEY must both be set");
	}
	const host = (env.RELAY_HOST ?? "127.0.0.1").trim();
	if (host !== "127.0.0.1" && host !== "::1") {
		throw new Error("Invalid RELAY_HOST: the relay must bind loopback only");
	}
	return {
		host,
		port: intOrDefault(env.RELAY_PORT, 8788),
		secret,
		apiKey,
		baseUrl: (env.RELAY_RESEND_BASE_URL ?? "https://api.resend.com").trim().replace(/\/$/, ""),
	};
}

function required(env: Record<string, string | undefined>, name: string): string {
	const value = (env[name] ?? "").trim();
	if (value === "") {
		throw new Error(`Sync worker requires ${name}.`);
	}
	return value;
}

function parseInterval(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_SECONDS;
	if (!/^\d+$/.test(raw.trim())) {
		throw new Error(`Invalid SYNC_INTERVAL_SECONDS: expected an integer, received "${raw}"`);
	}
	const seconds = Number.parseInt(raw.trim(), 10);
	if (seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
		throw new Error(
			`Invalid SYNC_INTERVAL_SECONDS: ${seconds} is outside ${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS}`,
		);
	}
	return seconds;
}

/**
 * Build the sync worker config.
 *
 * @throws when any required credential or endpoint is missing, so the worker
 * refuses to start rather than silently poll nothing.
 */
export function loadSyncConfig(env: Record<string, string | undefined> = {}): SyncConfig {
	return {
		dbPath: (env.SYNC_DB_PATH ?? env.DB_PATH ?? "var/harizco-post.sqlite").trim(),
		spoolDir: (env.SPOOL_DIR ?? "var/spool").trim(),
		resendApiKey: required(env, "RESEND_API_KEY"),
		resendBaseUrl: (env.RESEND_BASE_URL ?? "https://api.resend.com").trim(),
		provider: (env.RECEIVING_PROVIDER ?? "resend").trim(),
		intervalSeconds: parseInterval(env.SYNC_INTERVAL_SECONDS),
		stalwartUrl: required(env, "STALWART_URL").replace(/\/$/, ""),
		stalwartUsername: required(env, "STALWART_USERNAME"),
		stalwartSecret: required(env, "STALWART_SECRET"),
		...(env.STALWART_ACCOUNT_ID ? { stalwartAccountId: env.STALWART_ACCOUNT_ID.trim() } : {}),
	};
}
