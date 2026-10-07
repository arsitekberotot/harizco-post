// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: local Node runtime configuration.
//
// Loopback-only. Production private access fails closed: no TEAM_DOMAIN,
// POLICY_AUD and OWNER_EMAIL means the process refuses to start rather than
// serve an unauthenticated mailbox. Dev/fixture bypass flags are rejected in
// production — a bypass is never reachable through environment variables
// alone. Real Cloudflare Access JWT verification lands in a later task; until
// then the production path denies every private request.

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
	/**
	 * Present only when a complete, valid Access configuration was supplied.
	 * Absent means every private request is denied (fail closed).
	 */
	readonly access?: AppAccessConfig;
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
		throw new Error(`Invalid PORT: expected an integer 1-65535, received "${raw}"`);
	}
	const port = Number.parseInt(raw.trim(), 10);
	if (port < MIN_PORT || port > MAX_PORT) {
		throw new Error(`Invalid PORT: ${port} is outside 1-65535`);
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
			`Invalid HOST "${requestedHost}": Harizco Post only binds the loopback address ${LOOPBACK_HOST}`,
		);
	}

	const port = parsePort(env.PORT);

	const requestedBypasses = BYPASS_FLAGS.filter((flag) => isTruthy(env[flag]));

	const teamDomain = (env.TEAM_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
	const policyAud = (env.POLICY_AUD ?? "").trim();
	const ownerEmail = (env.OWNER_EMAIL ?? "").trim();

	const hasCompleteAccess = teamDomain !== "" && policyAud !== "" && ownerEmail !== "";

	if (isProduction) {
		if (!hasCompleteAccess) {
			const missing = [
				teamDomain === "" ? "TEAM_DOMAIN" : null,
				policyAud === "" ? "POLICY_AUD" : null,
				ownerEmail === "" ? "OWNER_EMAIL" : null,
			].filter((name): name is string => name !== null);
			throw new Error(
				`Refusing to start in production without Cloudflare Access configuration (missing: ${missing.join(", ")}). ` +
					"Harizco Post fails closed rather than serve an unauthenticated mailbox.",
			);
		}
		if (requestedBypasses.length > 0) {
			throw new Error(
				`Refusing to start in production with authentication bypass flags set (${requestedBypasses.join(", ")}). ` +
					"Fixture/dev bypass is never enabled by environment variables in production.",
			);
		}
	}

	const access: AppAccessConfig | undefined = hasCompleteAccess
		? {
				teamDomain:
					teamDomain === "" || teamDomain.includes(".") ? teamDomain : `${teamDomain}.cloudflareaccess.com`,
				policyAud,
				ownerEmail,
			}
		: undefined;

	return {
		host: LOOPBACK_HOST,
		port,
		nodeEnv,
		isProduction,
		...(access ? { access } : {}),
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
// The runner refuses intervals below 30s to respect provider rate limits, so
// the config floor matches rather than accepting a value the runner rejects.
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 3600;

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
