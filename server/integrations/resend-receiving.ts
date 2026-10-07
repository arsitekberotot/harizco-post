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
		this.#pageSize = Math.min(Math.max(opts.pageSize ?? DEFAULT_PAGE_SIZE, 1), 200);
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
			const retryable = res.status === 429 || res.status >= 500;
			const code = res.status === 429 ? "rate_limited" : res.status >= 500 ? "provider_error" : "client_error";
			throw new ResendError(code, redactSecrets(`Resend ${path} failed with ${res.status}.`), {
				retryable,
				status: res.status,
				retryAfterSeconds: retryAfter ? Number(retryAfter) : null,
			});
		}
		return { status: res.status, body: await res.json(), retryAfter };
	}

	async listPage(page: number, opts: { limit?: number } = {}): Promise<PageResult<ReceivedEmailSummary>> {
		const limit = Math.min(opts.limit ?? this.#pageSize, this.#pageSize);
		const { body } = await this.#getJson(`/emails/receiving?page=${page}&limit=${limit}`);
		const record = body as { data?: ReceivedEmailSummary[]; has_more?: boolean };
		const data = record.data ?? [];
		const hasMore = Boolean(record.has_more);
		return { data, hasMore, complete: !hasMore, page, pageSize: limit };
	}

	/** Iterate pages until `limit` records, `has_more` is false, or a cap is reached. */
	async *paginate(opts: { limit?: number; maxPages?: number } = {}): AsyncGenerator<PageResult<ReceivedEmailSummary>> {
		const maxPages = opts.maxPages ?? 100;
		let seen = 0;
		for (let page = 0; page < maxPages; page += 1) {
			const result = await this.listPage(page);
			seen += result.data.length;
			yield result;
			if (!result.hasMore) return;
			if (opts.limit !== undefined && seen >= opts.limit) return;
		}
	}

	async retrieve(id: string): Promise<ReceivedEmailDetail> {
		if (!id) throw new ResendError("invalid_id", "A received-email id is required.");
		const { body } = await this.#getJson(`/emails/receiving/${encodeURIComponent(id)}`);
		const record = body as ReceivedEmailSummary & {
			raw?: { download_url: string; expires_at: string } | null;
		};
		const raw = record.raw ?? null;
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
		if (!input.allowAnyHostForTest) this.#assertProviderHost(input.downloadUrl);

		const declared = await this.#fetch(input.downloadUrl, {
			headers: this.#headers(),
			signal: AbortSignal.timeout(this.#timeoutMs),
			redirect: "follow",
		});
		if (!declared.ok) {
			throw new ResendError("raw_fetch_failed", `Raw download failed with ${declared.status}.`, {
				retryable: declared.status === 429 || declared.status >= 500,
				status: declared.status,
			});
		}

		const lengthHeader = declared.headers.get("content-length");
		const declaredLength = lengthHeader ? Number(lengthHeader) : null;
		if (declaredLength !== null && declaredLength > this.#maxRawBytes) {
			throw new ResendError(
				"raw_too_large",
				`Raw message (${declaredLength} bytes) exceeds the configured limit of ${this.#maxRawBytes} bytes.`,
				{ retryable: false },
			);
		}

		const chunks: Uint8Array[] = [];
		let total = 0;
		const reader = declared.body?.getReader();
		if (reader) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > this.#maxRawBytes) {
					await reader.cancel();
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
