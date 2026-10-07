// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: local Hono application composition.
//
// This composes the API surface served by the loopback Node runtime. It does
// NOT implement Cloudflare Access JWT verification yet — the production path
// is fail-closed (deny every private request) until that lands. It never
// fabricates mailbox data: without a mailbox backend, authenticated private
// reads return an honest 503.

import { Hono } from "hono";
import type { AppConfig } from "./config";

/** Authentication strategies supported by the composition root. */
export type AuthMode =
	/** Production-style Cloudflare Access path. Denies until JWT checks land. */
	| "access"
	/** Explicit test-only seam. Never reachable from production env alone. */
	| "fixture";

export interface MailStoreCall {
	method: string;
	path: string;
}

/**
 * Mail storage boundary. The real JMAP/Stalwart adapter arrives in a later
 * phase; Phase 1 injects an explicit probe or nothing at all.
 */
export interface MailStore {
	listMailboxes(): Promise<unknown>;
	record?(method: string, path: string): void;
}

export interface CreateAppOptions {
	config: AppConfig;
	authMode?: AuthMode;
	/** Test seam. Absent in production until the Phase 2 adapter exists. */
	mailStore?: MailStore;
}

const NO_STORE = "no-store";

/** Every private API response is uncacheable. */
function applyPrivateHeaders(headers: Headers): void {
	headers.set("Cache-Control", NO_STORE);
	headers.set("Pragma", "no-cache");
	headers.set("X-Robots-Tag", "noindex, nofollow");
}

function jsonError(status: number, error: string): Response {
	const headers = new Headers({
		"Content-Type": "application/json; charset=utf-8",
	});
	if (status >= 400) applyPrivateHeaders(headers);
	return new Response(JSON.stringify({ error }), { status, headers });
}

/**
 * Production private authorization.
 *
 * Until Cloudflare Access JWT verification is implemented, this denies every
 * private request — including requests that merely present Access identity
 * headers. Header presence alone is attacker-controlled and is not identity.
 *
 * @returns `null` when authorized, otherwise the denial response.
 */
function denyPrivateAccess(): Response {
	return jsonError(403, "Forbidden: Cloudflare Access verification is not available in this build");
}

export function createApp(options: CreateAppOptions): Hono {
	const { config, mailStore } = options;
	const authMode: AuthMode = options.authMode ?? "access";

	// A fixture auth mode must never be reachable in production, even if a
	// caller passes it explicitly.
	if (authMode === "fixture" && config.isProduction) {
		throw new Error("Refusing to compose the app with fixture auth in production");
	}

	const app = new Hono();

	// --- Non-sensitive readiness ------------------------------------------
	// Reachable without authentication. Exposes no identities, secrets, or
	// configuration values.
	app.get("/health", (c) => {
		c.header("Cache-Control", NO_STORE);
		return c.json({
			ok: true,
			service: "harizco-post",
			mode: authMode,
			mailBackend: mailStore ? "configured" : "unavailable",
		});
	});

	// --- Private API ------------------------------------------------------
	// Anything under /api requires authorization and never falls back to HTML.
	//
	// Unknown /api paths must still answer with a JSON 404 rather than leak the
	// auth gate's status, so the surface is matched exactly: only endpoints the
	// application actually implements are treated as private resources.
	const PRIVATE_API_ROUTES = new Set(["/api/v1/mailboxes"]);

	app.all("/api/*", async (c) => {
		const path = new URL(c.req.url).pathname;

		if (!PRIVATE_API_ROUTES.has(path)) {
			return jsonError(404, "Not found");
		}

		if (authMode === "access") {
			// Fail closed: no verified identity is possible yet.
			return denyPrivateAccess();
		}

		// authMode === "fixture": explicit test-only seam.
		const method = c.req.method;
		mailStore?.record?.(method, path);

		if (!mailStore) {
			return jsonError(503, "Mailbox backend is not available yet");
		}

		return jsonError(503, "Mailbox backend is not available yet");
	});

	// --- Unknown /api routes: JSON 404, never SPA HTML ---------------------
	// Registered after the private API handler so unmatched /api paths still
	// return JSON rather than the client shell.
	app.all("/api", (c) => jsonError(404, "Not found"));

	app.notFound((c) => {
		const path = new URL(c.req.url).pathname;
		if (path === "/api" || path.startsWith("/api/")) {
			return jsonError(404, "Not found");
		}
		return c.json({ error: "Not found" }, 404);
	});

	return app;
}
