// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: local Hono application composition.
//
// This composes the API surface served by the loopback Node runtime. The
// production path is fail-closed: until Cloudflare Access JWT verification
// lands (Phase 5) every private request is denied, and header presence alone is
// never treated as identity.
//
// Mail is reached only through the MailBackend port (server/mail/backend.ts).
// When no backend is configured, authenticated private reads return an honest
// 503 rather than fabricating data.

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppConfig } from "./config";
import type { MailBackend, ConfiguredAddresses, FlagInput } from "./mail/backend";

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
 * Legacy Phase 1 probe seam. Retained so the fail-closed runtime contracts keep
 * proving that a probe with no real backend yields 503, never fabricated data.
 */
export interface MailStore {
	listMailboxes(): Promise<unknown>;
	record?(method: string, path: string): void;
}

export interface CreateAppOptions {
	config: AppConfig;
	authMode?: AuthMode;
	/** Legacy probe seam (Phase 1 runtime contracts). */
	mailStore?: MailStore;
	/** Real mail backend (Phase 2+). */
	backend?: MailBackend;
	/** Operator-provisioned address map returned by GET /api/v1/config. */
	addresses?: ConfiguredAddresses;
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

function jsonOk(value: unknown, status = 200): Response {
	const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
	applyPrivateHeaders(headers);
	return new Response(JSON.stringify(value), { status, headers });
}

/**
 * Production private authorization.
 *
 * Until Cloudflare Access JWT verification is implemented, this denies every
 * private request — including requests that merely present Access identity
 * headers. Header presence alone is attacker-controlled and is not identity.
 */
function denyPrivateAccess(): Response {
	return jsonError(403, "Forbidden: Cloudflare Access verification is not available in this build");
}

/**
 * The exact private API surface. Unknown /api paths must answer with a JSON 404
 * rather than leak the auth gate's status, so only implemented endpoints are
 * treated as private resources.
 */
function isPrivateApiPath(path: string): boolean {
	if (path === "/api/v1/config" || path === "/api/v1/mailboxes") return true;
	if (/^\/api\/v1\/mailboxes\/[^/]+$/.test(path)) return true;
	if (/^\/api\/v1\/mailboxes\/[^/]+\/emails$/.test(path)) return true;
	if (/^\/api\/v1\/mailboxes\/[^/]+\/emails\/[^/]+$/.test(path)) return true;
	if (/^\/api\/v1\/mailboxes\/[^/]+\/emails\/[^/]+\/move$/.test(path)) return true;
	if (/^\/api\/v1\/mailboxes\/[^/]+\/folders$/.test(path)) return true;
	if (/^\/api\/v1\/mailboxes\/[^/]+\/folders\/[^/]+$/.test(path)) return true;
	if (/^\/api\/v1\/mailboxes\/[^/]+\/drafts$/.test(path)) return true;
	if (/^\/api\/v1\/mailboxes\/[^/]+\/threads\/[^/]+\/read$/.test(path)) return true;
	if (/^\/api\/v1\/mailboxes\/[^/]+\/search$/.test(path)) return true;
	return false;
}

export function createApp(options: CreateAppOptions): Hono {
	const { config, mailStore, backend } = options;
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
			mailBackend: backend ? "configured" : mailStore ? "probe" : "unavailable",
		});
	});

	// --- Private API ------------------------------------------------------
	app.all("/api/*", async (c) => {
		const path = new URL(c.req.url).pathname;

		if (!isPrivateApiPath(path)) {
			return jsonError(404, "Not found");
		}

		if (authMode === "access") {
			// Fail closed: no verified identity is possible yet.
			return denyPrivateAccess();
		}

		// authMode === "fixture": explicit test-only seam.
		const method = c.req.method;
		mailStore?.record?.(method, path);

		// No real backend is wired yet: keep the honest 503 (Phase 1 contract),
		// even when a probe is present. A probe is not a mailbox.
		if (!backend) {
			return jsonError(503, "Mailbox backend is not available yet");
		}

		return handlePrivateRoute(c, path, method, backend, options.addresses);
	});

	// --- Unknown /api routes: JSON 404, never SPA HTML ---------------------
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

/**
 * Route a matched private API request to the backend.
 *
 * Any backend failure becomes a 502 with a generic message: internal errors are
 * never echoed to the browser, so a JMAP outage cannot leak hostnames, tokens,
 * or server internals.
 */
async function handlePrivateRoute(
	c: Context,
	path: string,
	method: string,
	backend: MailBackend,
	addresses: ConfiguredAddresses | undefined,
): Promise<Response> {
	try {
		if (method === "GET" && path === "/api/v1/config") {
			return jsonOk(addresses ?? { domains: [], emailAddresses: [] });
		}

		if (method === "GET" && path === "/api/v1/mailboxes") {
			return jsonOk(await backend.listMailboxes());
		}

		let m = /^\/api\/v1\/mailboxes\/([^/]+)$/.exec(path);
		if (m && method === "GET") {
			const mailbox = await backend.getMailbox(decodeURIComponent(m[1]));
			if (!mailbox) return jsonError(404, "Not found");
			return jsonOk(mailbox);
		}

		m = /^\/api\/v1\/mailboxes\/([^/]+)\/emails$/.exec(path);
		if (m && method === "GET") {
			const mailboxId = decodeURIComponent(m[1]);
			const url = new URL(c.req.url);
			const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
			const offset = clampInt(url.searchParams.get("offset"), 0, 0, 100000);
			return jsonOk(await backend.listEmails(mailboxId, { limit, offset }));
		}

		m = /^\/api\/v1\/mailboxes\/([^/]+)\/emails\/([^/]+)\/move$/.exec(path);
		if (m && method === "POST") {
			const mailboxId = decodeURIComponent(m[1]);
			const emailId = decodeURIComponent(m[2]);
			const body = await readJson(c);
			if (!body) return jsonError(400, "Invalid JSON body");
			const to = typeof body.mailboxId === "string" ? body.mailboxId : null;
			if (!to) return jsonError(400, "mailboxId is required");
			const result = await backend.move([emailId], mailboxId, to);
			return jsonOk(result);
		}

		m = /^\/api\/v1\/mailboxes\/([^/]+)\/emails\/([^/]+)$/.exec(path);
		if (m) {
			const mailboxId = decodeURIComponent(m[1]);
			const emailId = decodeURIComponent(m[2]);
			if (method === "GET") {
				const email = await backend.getEmail(emailId);
				if (!email || !email.mailboxIds.includes(mailboxId)) {
					return jsonError(404, "Not found");
				}
				return jsonOk(email);
			}
			if (method === "PATCH") {
				const body = await readJson(c);
				if (!body) return jsonError(400, "Invalid JSON body");
				const flags: FlagInput = {};
				if (typeof body.unread === "boolean") flags.read = !body.unread;
				if (typeof body.starred === "boolean") flags.starred = body.starred;
				return jsonOk(await backend.setFlags([emailId], flags));
			}
		}

		m = /^\/api\/v1\/mailboxes\/([^/]+)\/folders$/.exec(path);
		if (m) {
			const mailboxId = decodeURIComponent(m[1]);
			if (method === "GET") {
				return jsonOk(await backend.listMailboxes());
			}
			if (method === "POST") {
				const body = await readJson(c);
				if (!body) return jsonError(400, "Invalid JSON body");
				if (typeof body.name !== "string" || body.name.trim() === "") {
					return jsonError(400, "name is required");
				}
				const created = await backend.createFolder({
					name: body.name,
					parentId: typeof body.parentId === "string" ? body.parentId : null,
				});
				return jsonOk(created);
			}
			void mailboxId;
		}

		m = /^\/api\/v1\/mailboxes\/([^/]+)\/folders\/([^/]+)$/.exec(path);
		if (m) {
			const folderId = decodeURIComponent(m[2]);
			if (method === "PATCH") {
				const body = await readJson(c);
				if (!body) return jsonError(400, "Invalid JSON body");
				if (typeof body.name !== "string" || body.name.trim() === "") {
					return jsonError(400, "name is required");
				}
				return jsonOk(await backend.renameFolder(folderId, body.name));
			}
			if (method === "DELETE") {
				const url = new URL(c.req.url);
				let moveTo = url.searchParams.get("moveToMailboxId");
				if (!moveTo) {
					const body = await readJson(c);
					moveTo = body && typeof body.moveToMailboxId === "string" ? body.moveToMailboxId : null;
				}
				if (!moveTo) return jsonError(400, "moveToMailboxId is required to delete a folder");
				return jsonOk(await backend.deleteFolder(folderId, moveTo));
			}
		}

		m = /^\/api\/v1\/mailboxes\/([^/]+)\/drafts$/.exec(path);
		if (m && method === "POST") {
			const mailboxId = decodeURIComponent(m[1]);
			const body = await readJson(c);
			if (!body) return jsonError(400, "Invalid JSON body");
			if (typeof body.body !== "string") return jsonError(400, "body is required");
			const draft = await backend.createDraft({
				mailboxId,
				to: asStringArray(body.to),
				cc: asStringArray(body.cc),
				bcc: asStringArray(body.bcc),
				subject: typeof body.subject === "string" ? body.subject : "",
				body: body.body,
				replacesDraftId: typeof body.replacesDraftId === "string" ? body.replacesDraftId : null,
			});
			// The client consumes `draft_id`, not `draftId`.
			return jsonOk({ draft_id: draft.draftId });
		}

		m = /^\/api\/v1\/mailboxes\/([^/]+)\/threads\/([^/]+)\/read$/.exec(path);
		if (m && method === "POST") {
			const mailboxId = decodeURIComponent(m[1]);
			const body = await readJson(c);
			const ids = body ? asStringArray(body.emailIds) : [];
			if (!ids || ids.length === 0) return jsonError(400, "emailIds is required");
			const read = body && typeof body.read === "boolean" ? body.read : true;
			return jsonOk(await backend.setThreadRead(mailboxId, ids, read));
		}

		m = /^\/api\/v1\/mailboxes\/([^/]+)\/search$/.exec(path);
		if (m && (method === "GET" || method === "POST")) {
			const mailboxId = decodeURIComponent(m[1]);
			let filter: Record<string, unknown> = {};
			if (method === "GET") {
				const url = new URL(c.req.url);
				const q = url.searchParams.get("q");
				if (q) filter = { text: q };
			} else {
				const body = await readJson(c);
				filter = body && typeof body === "object" ? body : {};
			}
			return jsonOk(await backend.search(mailboxId, filter));
		}

		return jsonError(404, "Not found");
	} catch (err) {
		// Never leak backend internals to the browser.
		const detail = err instanceof Error ? err.message : "unknown";
		return jsonError(502, "Mail backend request failed");
		// `detail` intentionally unused in the response; kept for local logging
		// in a later phase without changing the wire contract.
		void detail;
	}
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
	if (raw === null) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
	try {
		const body = await c.req.json();
		if (body && typeof body === "object" && !Array.isArray(body)) {
			return body as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

/** Coerce an unknown value into a string array, dropping non-strings. */
function asStringArray(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return undefined;
	const out = value.filter((v): v is string => typeof v === "string");
	return out.length > 0 ? out : undefined;
}
