// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: Resend receiving API client.
//
// Pull-based ingress. Key safety properties:
//   - listings are explicitly paginated and a `has_more` page is never treated
//     as complete, so a discovery checkpoint cannot skip undiscovered mail;
//   - only provider-supplied download URLs are fetched;
//   - downloads are streamed with a byte ceiling;
//   - signed URLs are re-retrieved on expiry rather than persisted as archives;
//   - secrets and signed URLs are redacted from errors.

export class ResendError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly status: number | null;
	readonly retryAfterSeconds: number | null;
	constructor(
		code: string,
		message: string,
		opts: { retryable?: boolean; status?: number | null; retryAfterSeconds?: number | null } = {},
	) {
		super(message);
		this.code = code;
		this.retryable = opts.retryable ?? false;
		this.status = opts.status ?? null;
		this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
		this.name = "ResendError";
	}
}

export interface ReceivedEmailSummary {
	id: string;
	to?: string[];
	from?: string;
	subject?: string;
	created_at?: string;
	[key: string]: unknown;
}

export interface ReceivedEmailDetail extends ReceivedEmailSummary {
	raw: { download_url: string; expires_at: string } | null;
	rawAvailable: boolean;
}

export interface ResendReceivingOptions {
	apiKey: string;
	fetch?: typeof fetch;
	baseUrl?: string;
	pageSize?: number;
	timeoutMs?: number;
	maxRawBytes?: number;
	/** Hosts permitted for provider download URLs. */
	allowedDownloadHosts?: string[];
}

const DEFAULT_HOST = "api.resend.com";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_RAW_BYTES = 40 * 1024 * 1024;

function retryHint(value: string | null): number | null {
	if (!value) return null;
	if (/^\d+$/.test(value.trim())) {
		const seconds = Number(value);
		return Number.isSafeInteger(seconds) ? seconds : null;
	}
	// HTTP dates require an alphabetic month; do not parse negative numbers as dates.
	if (!/[A-Za-z]/.test(value)) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - Date.now()) / 1000)) : null;
}

/** Cleanup is bounded; errors must never expose remote body text or signed URLs. */
async function discardStream(stream: { cancel(): Promise<void> } | null, strict = false, timeoutMs = 1000): Promise<void> {
	if (!stream) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			stream.cancel(),
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cleanup timeout")), Math.min(timeoutMs, 1000)); }),
		]);
	} catch {
		if (strict) throw new ResendError("network", "Raw redirect body could not be discarded.", { retryable: true });
	} finally {
		clearTimeout(timer);
	}
}

export function redactSecrets(input: string): string {
	let out = input;
	// API keys (re_...) and bearer tokens.
	out = out.replace(/\bre_[A-Za-z0-9_-]{6,}\b/g, "re_[redacted]");
	out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
	// Query-string secrets in signed URLs (token/signature/expires params).
	out = out.replace(/([?&](?:token|signature|sig|key|expires|se|sp|sv|sr)=)[^&\s"']+/gi, "$1[redacted]");
	// Basic-auth style credentials embedded in a URL.
	out = out.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@");
	return out;
}

export function isRawExpired(raw: { download_url: string; expires_at: string } | null | undefined): boolean {
	if (!raw) return true;
	const expiry = Date.parse(raw.expires_at);
	if (Number.isNaN(expiry)) return true;
	// Treat a URL expiring within the next 30s as already expired to avoid a
	// download that will fail mid-stream.
	return expiry - Date.now() < 30_000;
}

export interface PageResult<T> {
	data: T[];
	hasMore: boolean;
	/** True only when the provider reports no further pages. */
	complete: boolean;
	page: number;
	pageSize: number;
}

export class ResendReceivingClient {
	readonly #apiKey: string;
	readonly #fetch: typeof fetch;
	readonly #baseUrl: string;
	readonly #pageSize: number;
	readonly #timeoutMs: number;
	readonly #maxRawBytes: number;
	readonly #allowedHosts: Set<string>;

	constructor(opts: ResendReceivingOptions) {
		if (!opts.apiKey) throw new ResendError("invalid_config", "A Resend API key is required.");
		this.#apiKey = opts.apiKey;
		this.#fetch = opts.fetch ?? fetch;
		this.#baseUrl = (opts.baseUrl ?? `https://${DEFAULT_HOST}`).replace(/\/$/, "");
		this.#pageSize = Math.min(Math.max(opts.pageSize ?? DEFAULT_PAGE_SIZE, 1), 100);
		this.#timeoutMs = opts.timeoutMs ?? 20_000;
		this.#maxRawBytes = opts.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES;
		this.#allowedHosts = new Set(opts.allowedDownloadHosts ?? []);
	}

	#headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" };
	}

	async #getJson(path: string): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
		let res: Response;
		try {
			res = await this.#fetch(`${this.#baseUrl}${path}`, {
				headers: this.#headers(),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch (err) {
			// Abort/timeout and network failures are retryable.
			throw new ResendError("network", redactSecrets(`Resend request failed: ${(err as Error).message}`), {
				retryable: true,
			});
		}
		const retryAfter = res.headers.get("retry-after");
		if (!res.ok) {
			await discardStream(res.body, false, this.#timeoutMs);
			const retryable = res.status === 429 || res.status >= 500;
			const code = res.status === 429 ? "rate_limited" : res.status >= 500 ? "provider_error" : "client_error";
			throw new ResendError(code, redactSecrets(`Resend ${path} failed with ${res.status}.`), {
				retryable,
				status: res.status,
				retryAfterSeconds: retryHint(retryAfter),
			});
		}
		try {
			return { status: res.status, body: await res.json(), retryAfter };
		} catch {
			// Native parse/stream errors may include response content and secrets.
			throw new ResendError("invalid_response", "Receiving response could not be decoded.", { retryable: true });
		}
	}

	/** `page` is a local counter, not a provider parameter. Resend uses cursors. */
	async listPage(page: number, opts: { limit?: number; after?: string; before?: string } = {}): Promise<PageResult<ReceivedEmailSummary>> {
		const limit = Math.min(opts.limit ?? this.#pageSize, this.#pageSize);
		if (!Number.isInteger(limit) || limit < 1 || opts.after && opts.before) {
			throw new ResendError("invalid_config", "Invalid receiving pagination parameters.");
		}
		const query = new URLSearchParams({ limit: String(limit) });
		if (opts.after) query.set("after", opts.after);
		if (opts.before) query.set("before", opts.before);
		const { body } = await this.#getJson(`/emails/receiving?${query}`);
		const record = body as { data?: ReceivedEmailSummary[]; has_more?: boolean } | null;
		if (!record || !Array.isArray(record.data) || typeof record.has_more !== "boolean" ||
			record.data.some((r) => !r || typeof r.id !== "string" || !r.id) ||
			record.data.length > limit || record.has_more && !record.data.length) {
			throw new ResendError("invalid_response", "Invalid receiving listing response.", { retryable: true });
		}
		const data = record.data;
		const hasMore = record.has_more;
		return { data, hasMore, complete: !hasMore, page, pageSize: limit };
	}

	/** Iterate pages until `limit` records, `has_more` is false, or a cap is reached. */
	async *paginate(opts: { limit?: number; maxPages?: number } = {}): AsyncGenerator<PageResult<ReceivedEmailSummary>> {
		const maxPages = opts.maxPages ?? 100;
		let seen = 0;
		let after: string | undefined;
		const cursors = new Set<string>();
		for (let page = 0; page < maxPages; page += 1) {
			const result = await this.listPage(page, { after });
			if (result.hasMore) {
				const next = result.data.at(-1)?.id;
				if (!next || cursors.has(next)) {
					throw new ResendError("invalid_response", "Receiving cursor did not advance.", { retryable: true });
				}
				cursors.add(next);
				after = next;
			}
			seen += result.data.length;
			yield result;
			if (!result.hasMore) return;
			if (opts.limit !== undefined && seen >= opts.limit) return;
		}
	}

	async retrieve(id: string): Promise<ReceivedEmailDetail> {
		if (!id) throw new ResendError("invalid_id", "A received-email id is required.");
		const { body } = await this.#getJson(`/emails/receiving/${encodeURIComponent(id)}`);
		const record = body as ReceivedEmailDetail | null;
		if (!record || Array.isArray(record) || typeof record !== "object" || record.id !== id || !Object.hasOwn(record, "raw")) {
			throw new ResendError("invalid_response", "Invalid received-email metadata.", { retryable: true });
		}
		const raw = record.raw;
		if (raw !== null && (!raw || typeof raw !== "object" || Array.isArray(raw) ||
			typeof raw.download_url !== "string" || !raw.download_url ||
			typeof raw.expires_at !== "string" || !Number.isFinite(Date.parse(raw.expires_at)))) {
			throw new ResendError("invalid_response", "Invalid original MIME metadata.", { retryable: true });
		}
		return { ...record, raw, rawAvailable: raw !== null && !isRawExpired(raw) };
	}

	#assertProviderHost(downloadUrl: string): void {
		let parsed: URL;
		try {
			parsed = new URL(downloadUrl);
		} catch {
			throw new ResendError("invalid_url", "Download URL is not a valid absolute URL.");
		}
		if (parsed.protocol !== "https:") {
			throw new ResendError("invalid_url", "Download URL must use https.");
		}
		if (parsed.username || parsed.password || parsed.port && parsed.port !== "443") {
			throw new ResendError("invalid_url", "Download URL credentials and alternate ports are not permitted.");
		}
		const host = parsed.hostname;
		const known = this.#allowedHosts.has(host) || host === DEFAULT_HOST || host.endsWith(".resend.com");
		if (!known) {
			throw new ResendError(
				"untrusted_url",
				`Refusing to download from a host that is not a provider-supplied Resend URL: ${host}.`,
			);
		}
	}

	/**
	 * Stream a raw MIME download with a hard byte ceiling. A partial download is
	 * rejected rather than imported, so an incomplete message never enters the
	 * mailbox as a silently truncated email.
	 */
	async fetchRaw(input: {
		downloadUrl: string;
		allowAnyHostForTest?: boolean;
	}): Promise<{ bytes: Uint8Array; contentLength: number }> {
		// Signed download URLs authorize themselves. NEVER forward the API key.
		// Each redirect is separately allowlisted before another request is made.
		let currentUrl = input.downloadUrl;
		let declared: Response | undefined;
		const signal = AbortSignal.timeout(this.#timeoutMs);
		for (let hop = 0; hop <= 3; hop++) {
			this.#assertProviderHost(currentUrl);
			try {
				declared = await this.#fetch(currentUrl, { signal, redirect: "manual" });
			} catch {
				throw new ResendError("network", "Raw MIME download failed or timed out.", { retryable: true });
			}
			if (![301, 302, 303, 307, 308].includes(declared.status)) break;
			const location = declared.headers.get("location");
			await discardStream(declared.body, true, this.#timeoutMs);
			if (!location || hop === 3) {
				throw new ResendError("invalid_url", "Raw download redirect limit or missing location.");
			}
			try { currentUrl = new URL(location, currentUrl).href; }
			catch { throw new ResendError("invalid_url", "Invalid raw download redirect."); }
		}
		if (!declared) throw new ResendError("raw_fetch_failed", "Raw download unavailable.", { retryable: true });
		if (!declared.ok) {
			await discardStream(declared.body, false, this.#timeoutMs);
			throw new ResendError("raw_fetch_failed", `Raw download failed with ${declared.status}.`, {
				retryable: declared.status === 429 || declared.status >= 500,
				status: declared.status,
				retryAfterSeconds: retryHint(declared.headers.get("retry-after")),
			});
		}

		const lengthHeader = declared.headers.get("content-length");
		const declaredLength = lengthHeader ? Number(lengthHeader) : null;
		if (declaredLength !== null && declaredLength > this.#maxRawBytes) {
			await discardStream(declared.body, false, this.#timeoutMs);
			throw new ResendError(
				"raw_too_large",
				`Raw message (${declaredLength} bytes) exceeds the configured limit of ${this.#maxRawBytes} bytes.`,
				{ retryable: false },
			);
		}

		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
		const reader = declared.body?.getReader();
		if (reader) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > this.#maxRawBytes) {
					await discardStream(reader, false, this.#timeoutMs);
					throw new ResendError(
						"raw_too_large",
						`Raw message exceeded the configured limit of ${this.#maxRawBytes} bytes mid-stream.`,
						{ retryable: false },
					);
				}
				chunks.push(value);
			}
		} else {
			const buf = new Uint8Array(await declared.arrayBuffer());
			total = buf.byteLength;
			if (total > this.#maxRawBytes) {
				throw new ResendError("raw_too_large", "Raw message exceeds the configured limit.", { retryable: false });
			}
			chunks.push(buf);
		}
		} catch (err) {
			if (err instanceof ResendError) throw err;
			throw new ResendError("network", "Raw MIME body could not be completely read.", { retryable: true });
		}

		if (declaredLength !== null && total !== declaredLength) {
			throw new ResendError("raw_incomplete", `Raw download was ${total} bytes but declared ${declaredLength}.`, {
				retryable: true,
			});
		}

		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { bytes, contentLength: total };
	}
}
