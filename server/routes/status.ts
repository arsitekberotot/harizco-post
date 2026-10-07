// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: operational status route.
//
// Status is authenticated and deliberately content-free: an operator can tell
// whether sync is healthy without the endpoint ever exposing mail bodies,
// recipients, subjects, provider tokens, or signed download URLs.

import type { Journal } from "../db/index";

export interface StatusReport {
	lastSuccessAt: string | null;
	pending: number;
	failed: number;
	quarantined: number;
	verified: number;
	oldestPendingAt: string | null;
}

export interface StatusInput {
	db: Journal;
	lastSuccessAt?: string | null;
	provider?: string;
}

export function buildStatusReport(input: StatusInput): StatusReport {
	const { db, provider } = input;
	const filter = provider ? " AND provider = ?" : "";
	const args = provider ? [provider] : [];

	const count = (state: string): number => {
		const row = db
			.prepare(`SELECT COUNT(*) AS n FROM import_jobs WHERE state = ?${filter}`)
			.get(state, ...args) as { n: number };
		return row.n;
	};

	const oldest = db
		.prepare(`SELECT MIN(created_at) AS at FROM import_jobs WHERE state = 'pending'${filter}`)
		.get(...args) as { at: string | null };

	return {
		lastSuccessAt: input.lastSuccessAt ?? null,
		pending: count("pending") + count("spooled") + count("uploaded") + count("imported"),
		failed: count("failed"),
		quarantined: count("quarantined"),
		verified: count("verified"),
		oldestPendingAt: oldest.at ?? null,
	};
}

const SECRET_KEY_PATTERN = /(token|secret|key|authorization|password|signature|sig|credential)/i;
const CONTENT_KEY_PATTERN = /(subject|body|text|html|preview|recipient|^to$|^from$|email|mime|raw|snippet|download)/i;

/**
 * Recursively redact anything that could carry a secret or message content.
 * Operationally useful fields (ids, states, counts, timestamps) survive.
 */
export function redactForLog(value: unknown, depth = 0): unknown {
	if (depth > 12) return "[depth-limited]";
	if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
	if (value === null || typeof value !== "object") {
		if (typeof value === "string") {
			// Scrub inline secrets/signed URLs from free-form strings too.
			return value
				.replace(/\bre_[A-Za-z0-9_-]{6,}\b/g, "[redacted]")
				.replace(/([?&](?:token|signature|sig|key|expires)=)[^&\s"']+/gi, "$1[redacted]");
		}
		return value;
	}

	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(k) || CONTENT_KEY_PATTERN.test(k)) {
			out[k] = "[redacted]";
			continue;
		}
		out[k] = redactForLog(v, depth + 1);
	}
	return out;
}
