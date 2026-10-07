// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: local production entrypoint (loopback only).
//
// Serves the built SPA (dist/client) and the Hono API on 127.0.0.1. There is
// no public bind here by design: Cloudflare Tunnel terminates TLS and Access
// in front of this process in a later phase.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { serve } from "@hono/node-server";
import { createApp, type AuthMode } from "./app";
import { loadConfig } from "./config";

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json; charset=utf-8",
};

const CLIENT_DIR = resolve(process.env.CLIENT_DIR ?? "dist/client");

function isContained(base: string, candidate: string): boolean {
	return candidate === base || candidate.startsWith(base + sep);
}

/** Resolve a request path to a real file inside the client bundle, or null. */
function resolveStaticFile(pathname: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (decoded.includes("\0")) return null;

	const candidate = resolve(join(CLIENT_DIR, normalize(decoded)));
	if (!isContained(CLIENT_DIR, candidate)) return null;

	if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	return null;
}

function staticResponse(file: string, method: string): Response {
	const headers = new Headers({
		"Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
		// Hashed build assets are immutable; the shell is revalidated.
		"Cache-Control": file.includes(`${sep}assets${sep}`)
			? "public, max-age=31536000, immutable"
			: "no-cache",
	});
	if (method === "HEAD") {
		return new Response(null, { status: 200, headers });
	}
	const stream = createReadStream(file) as unknown as ReadableStream;
	return new Response(stream, { status: 200, headers });
}

function spaShell(method: string): Response | null {
	const indexFile = join(CLIENT_DIR, "index.html");
	if (!existsSync(indexFile)) return null;
	const headers = new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-cache",
	});
	if (method === "HEAD") return new Response(null, { status: 200, headers });
	return new Response(readFileSync(indexFile), { status: 200, headers });
}

function start(): void {
	if (!existsSync(CLIENT_DIR)) {
		console.error(
			`[harizco-post] Built client bundle not found at ${CLIENT_DIR}. Run "npm run build" first.`,
		);
		process.exitCode = 1;
		return;
	}

	const config = loadConfig(process.env);
	// Phase 1 has no verified identity provider: production always denies
	// private access. The fixture seam is unreachable in production because
	// `loadConfig` and `createApp` both refuse it.
	const authMode: AuthMode = config.isProduction ? "access" : "access";
	const api = createApp({ config, authMode });

	serve(
		{
			hostname: config.host,
			port: config.port,
			fetch: (request) => {
				const url = new URL(request.url);

				// Non-API, non-health traffic is the SPA surface.
				if (!url.pathname.startsWith("/api") && url.pathname !== "/health") {
					const file = resolveStaticFile(url.pathname);
					if (file) return staticResponse(file, request.method);
					const shell = spaShell(request.method);
					if (shell) return shell;
					return new Response("Not found", { status: 404 });
				}

				return api.fetch(request);
			},
		},
		(info) => {
			console.log(
				`[harizco-post] listening on http://${info.address}:${info.port} (env=${config.nodeEnv})`,
			);
		},
	);
}

start();
