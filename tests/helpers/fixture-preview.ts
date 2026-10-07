// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// FIXTURE-ONLY preview server — NOT production and NOT a credential bypass.
// Serves built SPA assets (dist/client) plus synthetic read/list JSON on
// loopback for Playwright / local UI exercise. Must stay under tests/helpers/
// and must never be bundled into dist/server/index.js.

import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	FIXTURE_LABEL,
	FIXTURE_MAILBOX_ID,
	fixtureConfig,
	fixtureFolders,
	getFixtureEmail,
	getFixtureMailbox,
	listFixtureEmails,
	listFixtureMailboxes,
} from "../fixtures/mail/data.ts";

const HOST = "127.0.0.1";
export function fixturePreviewPort(value = process.env.FIXTURE_PREVIEW_PORT ?? "4173"): number {
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
		throw new Error("FIXTURE_PREVIEW_PORT must be an integer from 1 to 65535");
	}
	return Number(value);
}
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLIENT_DIR = join(ROOT, "dist", "client");

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
	".ico": "image/x-icon",
	".png": "image/png",
	".woff2": "font/woff2",
};

function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
	extraHeaders: Record<string, string> = {},
): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		// ASCII-only header token; full label stays in JSON/body text.
		"x-harizco-fixture": "synthetic-test-fixture",
		...extraHeaders,
	});
	res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
		"x-harizco-fixture": "synthetic-test-fixture",
	});
	res.end(body);
}

function contained(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function safeClientPath(urlPath: string, clientDir: string): string | null {
	const decoded = decodeURIComponent(urlPath);
	const candidate = resolve(clientDir, `.${decoded}`);
	if (!contained(clientDir, candidate)) return null;
	// Check existing ancestors too: a missing file under an escaping symlink
	// must not fall through to the SPA shell.
	let ancestor = candidate;
	while (!existsSync(ancestor) && ancestor !== clientDir) ancestor = resolve(ancestor, "..");
	if (!contained(realpathSync(clientDir), realpathSync(ancestor))) return null;
	return candidate;
}

function serveStatic(res: ServerResponse, filePath: string): boolean {
	if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
	const type = MIME[extname(filePath)];
	if (!type) return false;
	const stream = createReadStream(filePath);
	stream.once("error", () => {
		if (res.headersSent) res.destroy();
		else sendText(res, 500, "Unable to read fixture asset");
	});
	res.once("close", () => stream.destroy());
	stream.once("open", () => {
		res.writeHead(200, {
			"content-type": type,
			"cache-control": "no-store",
			"x-harizco-fixture": "synthetic-test-fixture",
		});
		stream.pipe(res);
	});
	return true;
}

function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
	const { pathname } = url;
	const method = req.method ?? "GET";

	if (pathname === "/health" || pathname === "/api/v1/health") {
		sendJson(res, 200, {
			ok: true,
			mode: "fixture-preview",
			label: FIXTURE_LABEL,
		});
		return true;
	}

	if (pathname.startsWith("/api/")) {
		if (method === "GET" && pathname === "/api/v1/config") {
			sendJson(res, 200, fixtureConfig);
			return true;
		}
		if (method === "GET" && pathname === "/api/v1/mailboxes") {
			sendJson(res, 200, listFixtureMailboxes());
			return true;
		}

		const mailboxMatch = pathname.match(
			/^\/api\/v1\/mailboxes\/([^/]+)(?:\/(emails|folders)(?:\/([^/]+))?)?$/,
		);
		if (mailboxMatch) {
			const mailboxId = decodeURIComponent(mailboxMatch[1]);
			const resource = mailboxMatch[2];
			const resourceId = mailboxMatch[3]
				? decodeURIComponent(mailboxMatch[3])
				: undefined;
			const mailbox = getFixtureMailbox(mailboxId);

			if (!mailbox) {
				sendJson(res, 404, { error: "Mailbox not found", label: FIXTURE_LABEL });
				return true;
			}

			if (!resource && method === "GET") {
				sendJson(res, 200, mailbox);
				return true;
			}
			if (resource === "folders" && method === "GET") {
				sendJson(res, 200, fixtureFolders);
				return true;
			}
			if (resource === "emails" && method === "GET") {
				if (resourceId) {
					const email = getFixtureEmail(resourceId);
					if (!email) {
						sendJson(res, 404, { error: "Email not found", label: FIXTURE_LABEL });
						return true;
					}
					sendJson(res, 200, email);
					return true;
				}
				const folder = url.searchParams.get("folder") ?? "inbox";
				const emails = listFixtureEmails(folder);
				sendJson(res, 200, {
					emails,
					totalCount: emails.length,
					label: FIXTURE_LABEL,
				});
				return true;
			}
		}

		sendJson(res, 404, { error: "Not found", label: FIXTURE_LABEL });
		return true;
	}

	return false;
}

function handler(req: IncomingMessage, res: ServerResponse, CLIENT_DIR: string): void {
	let url: URL;
	try {
		const target = req.url ?? "/";
		// Accept only origin-form requests; Host is validated, never used as a base.
		if (!target.startsWith("/") || target.startsWith("//") || /[\\#\s]/.test(target)) throw new Error("Invalid target");
		decodeURIComponent(target);
		if (target.includes("%00")) throw new Error("Invalid target");
		const host = req.headers.host;
		if (host !== undefined && !/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::[0-9]{1,5})?$/.test(host)) throw new Error("Invalid Host");
		if (host !== undefined) new URL(`http://${host}`);
		url = new URL(target, "http://127.0.0.1");
	} catch {
		sendText(res, 400, "Bad request");
		return;
	}
	if (req.method !== "GET" && req.method !== "HEAD") {
		sendText(res, 405, "Method not allowed");
		return;
	}
	if (handleApi(req, res, url)) return;

	if (!existsSync(CLIENT_DIR)) {
		sendText(
			res,
			503,
			[
				"FIXTURE-ONLY preview server",
				FIXTURE_LABEL,
				"",
				`Built client assets not found at ${CLIENT_DIR}.`,
				"Task 3 must produce build/client before browser tests can go GREEN.",
				`Known fixture mailbox id: ${FIXTURE_MAILBOX_ID}`,
			].join("\n"),
		);
		return;
	}

	const filePath = safeClientPath(url.pathname, CLIENT_DIR);
	if (!filePath) {
		sendText(res, 403, "Forbidden");
		return;
	}
	if (serveStatic(res, filePath)) return;

	const spaRoute = url.pathname === "/" || /^\/mailbox\/[^/]+\/(?:settings|emails\/[^/]+)$/.test(url.pathname);
	if (spaRoute) {
		const indexPath = safeClientPath("/index.html", CLIENT_DIR);
		if (!indexPath) {
			sendText(res, 403, "Forbidden");
			return;
		}
		if (serveStatic(res, indexPath)) return;
	}

	sendText(res, 404, "Not found");
}

export function createFixturePreviewServer(clientDir = CLIENT_DIR) {
	return createServer((req, res) => {
		try {
			handler(req, res, resolve(clientDir));
		} catch {
			if (res.headersSent) res.destroy();
			else sendText(res, 500, "Fixture preview error");
		}
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const PORT = fixturePreviewPort();
	const server = createFixturePreviewServer();

	server.listen(PORT, HOST, () => {
		process.stdout.write(
			[
				`[fixture-preview] FIXTURE-ONLY server listening on http://${HOST}:${PORT}`,
				`[fixture-preview] ${FIXTURE_LABEL}`,
				`[fixture-preview] client dir: ${CLIENT_DIR}`,
				`[fixture-preview] mailbox: ${FIXTURE_MAILBOX_ID}`,
			].join("\n") + "\n",
		);
	});

}
