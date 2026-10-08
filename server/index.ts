// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Loopback-only production entrypoint. The Hono security middleware runs
// before API dispatch, SPA shell reads, and static asset reads alike.

import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createApp, type CreateAppOptions } from "./app";
import { loadConfig, type AppConfig } from "./config";
import type { MailBackend, ConfiguredAddresses } from "./mail/backend";
import { JmapMailBackend } from "./mail/backend-jmap";
import { SubmissionStore } from "./mail/submissions";
import type { RelayOutcome, RelayRequest, RelayTransport } from "./mail/submissions";
import type { SenderPolicy } from "./mail/validation";
import { openJournal, type Journal, type MailboxRecord } from "./db/index";
import { MailboxRegistry } from "./mailboxes/registry";
import { loadOutboundBinding, type OutboundBinding } from "./config";
import { privateError } from "./auth/request";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".woff2": "font/woff2", ".woff": "font/woff",
};
const BUILD_ASSET = /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|jpe?g|webp|woff2?)$/;
const SPA_PATH = /^\/mailbox\/[A-Za-z0-9_-]+(?:\/(?:emails\/[A-Za-z0-9_-]+|settings|search))?$/;

function decodedPath(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path);
    if (/[\\\0%]/.test(decoded) || decoded.split("/").some(part => part === "." || part === "..")) return null;
    return decoded;
  } catch { return null; }
}

/** Trusted build directory only: realpath confinement includes symlink targets. */
function bundleResponse(root: string, relative: string, method: string): Response | null {
  let fd: number | undefined;
  try {
    let component = root;
    for (const part of relative.split("/")) {
      component = join(component, part);
      if (lstatSync(component).isSymbolicLink()) return null;
    }
    const file = realpathSync(join(root, relative));
    if (!file.startsWith(root + sep)) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile()) return null;
    // Check the name again after opening; never stream through a mutable symlink.
    const current = realpathSync(join(root, relative));
    if (current !== file || !current.startsWith(root + sep)) return null;
    const named = statSync(current);
    if (opened.dev !== named.dev || opened.ino !== named.ino) return null;
    const headers = new Headers({ "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
    return new Response(method === "HEAD" ? null : readFileSync(fd), { headers });
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export interface ProductionHandlerOptions extends CreateAppOptions { clientDir: string }

/**
 * Build the private mailbox backend from a validated web config.
 *
 * Returns null when no mailbox binding is configured so authenticated reads
 * keep their honest 503 instead of fabricating data. The optional `fetch` is a
 * synthetic-transport seam for tests; production passes nothing and uses the
 * real (loopback) transport. The secret is only ever sent by the JMAP client's
 * own request builder, never placed on a browser-facing response.
 */
export function createProductionBackend(
	config: AppConfig,
	options: { fetch?: typeof fetch } = {},
): MailBackend | null {
	const mailbox = config.mailbox;
	if (!mailbox) return null;
	const submission = createSubmissionWiring();
	return new JmapMailBackend({
		baseUrl: mailbox.url,
		auth: { username: mailbox.username, secret: mailbox.secret },
		...(mailbox.accountId ? { accountId: mailbox.accountId } : {}),
		...(options.fetch ? { fetch: options.fetch } : {}),
		...(submission ? { submission } : {}),
	});
}

/**
 * Build one JMAP client and sender policy per configured, operator-bound mailbox.
 *
 * `records` must come from the mailbox registry. Every configured address must
 * have exactly one JMAP account binding; disabled records are prepared here but
 * remain inaccessible until explicitly activated in the registry.
 */
export function createProductionMailboxBackends(
	config: AppConfig,
	records: readonly MailboxRecord[],
	binding: OutboundBinding | null,
	options: {
		fetch?: typeof fetch;
		db?: Journal;
		store?: SubmissionStore;
		transport?: RelayTransport;
	} = {},
): Map<string, MailBackend> {
	const mailbox = config.mailbox;
	const backends = new Map<string, MailBackend>();
	if (!mailbox) return backends;

	const boundByAddress = new Map(
		records
			.filter((record) => !!record.jmap_account_id)
			.map((record) => [record.address.trim().toLowerCase(), record]),
	);
	const addresses = binding?.addresses ?? [...boundByAddress.keys()];
	const accountOwners = new Map<string, string>();
	for (const address of addresses) {
		const record = boundByAddress.get(address);
		if (!record?.jmap_account_id) {
			throw new Error(`Configured mailbox ${address} has no JMAP account binding.`);
		}
		const priorAddress = accountOwners.get(record.jmap_account_id);
		if (priorAddress) {
			throw new Error(`JMAP account is bound to multiple mailboxes: ${priorAddress}, ${address}`);
		}
		accountOwners.set(record.jmap_account_id, address);
	}

	const store = binding
		? options.store ?? new SubmissionStore(options.db ?? openJournal(binding.dbPath))
		: undefined;
	const transport = binding ? options.transport ?? new HttpRelayTransport(binding.relayUrl) : undefined;
	for (const address of addresses) {
		const record = boundByAddress.get(address)!;
		const submission = binding && store && transport
			? { store, transport, policy: senderPolicyForAddress(binding, address) }
			: undefined;
		backends.set(address, new JmapMailBackend({
			baseUrl: mailbox.url,
			auth: { username: mailbox.username, secret: mailbox.secret },
			accountId: record.jmap_account_id!,
			...(options.fetch ? { fetch: options.fetch } : {}),
			...(submission ? { submission } : {}),
		}));
	}
	return backends;
}

/**
 * Derive the operator-provisioned address map returned by GET /api/v1/config
 * from the validated outbound binding.
 *
 * The binding is the single authoritative source of the owned sender identity:
 * `OUTBOUND_FROM` is validated at startup and its `domain` is derived from that
 * same address. The UI needs this to populate the mailbox-domain picker and to
 * enable Create. Without a binding there is no owned identity, so we return
 * undefined and the config route keeps its honest empty list rather than
 * inventing a domain.
 */
export function configuredAddressesFrom(
	binding: OutboundBinding | null,
): ConfiguredAddresses | undefined {
	if (!binding || !binding.addresses?.length || !binding.domain) return undefined;
	return { domains: [binding.domain], emailAddresses: [...binding.addresses] };
}

/** Build a sender policy bound to one configured account, never an alias set. */
export function senderPolicyForAddress(binding: OutboundBinding, mailboxAddress: string): SenderPolicy {
	const address = mailboxAddress.trim().toLowerCase();
	if (!binding.addresses.includes(address)) {
		throw new Error("Mailbox address is not configured for sending");
	}
	return {
		mailboxId: address,
		address,
		domain: binding.domain,
		maxRecipients: binding.maxRecipients,
		maxBytes: binding.maxBytes,
	};
}

/**
 * Build the outbound submission wiring, or null when it is not configured.
 *
 * The web process deliberately holds NO relay credential: it records the
 * durable intent in the journal and forwards the payload to `relayUrl`, which
 * the worker owns. Absent a binding, `sendEmail` refuses honestly.
 */
function createSubmissionWiring(
	mailboxAddress?: string,
): { store: SubmissionStore; transport: RelayTransport; policy: SenderPolicy } | null {
	const binding: OutboundBinding | null = loadOutboundBinding(process.env);
	if (!binding) return null;
	const store = new SubmissionStore(openJournal(binding.dbPath));
	const transport = new HttpRelayTransport(binding.relayUrl);
	const policy = senderPolicyForAddress(binding, mailboxAddress ?? binding.address);
	return { store, transport, policy };
}

/** Forwards a submission to the worker's relay, which holds the secret. */
class HttpRelayTransport implements RelayTransport {
	readonly #url: string;
	readonly #fetch: typeof fetch;
	constructor(url: string, fetchImpl: typeof fetch = fetch) {
		this.#url = url;
		this.#fetch = fetchImpl;
	}
	async send(request: RelayRequest): Promise<RelayOutcome> {
		try {
			const res = await this.#fetch(this.#url, {
				method: "POST",
				headers: { "content-type": "application/json", [request.idempotencyHeader.name]: request.idempotencyHeader.value },
				body: JSON.stringify({ requestId: request.requestId, payload: request.payload }),
				signal: AbortSignal.timeout(20_000),
			});
			if (res.ok) {
				const body = (await res.json()) as { providerId?: string };
				return body?.providerId
					? { status: "accepted", providerId: body.providerId }
					: { status: "ambiguous", reason: "relay accepted without a provider id" };
			}
			if (res.status === 429 || res.status >= 500) return { status: "ambiguous", reason: `relay returned ${res.status}` };
			return { status: "rejected", reason: `relay rejected with ${res.status}` };
		} catch (err) {
			return { status: "ambiguous", reason: `relay transport error: ${(err as Error).message}` };
		}
	}
}

/** This exact handler is passed to the actual loopback production listener. */
export function createProductionHandler(options: ProductionHandlerOptions): (request: Request) => Promise<Response> {
  if (options.authMode === "fixture") throw new Error("Production handler cannot use fixture authentication");
  const app = createApp({ ...options, authMode: "access" });
  const root = realpathSync(resolve(options.clientDir));
  app.all("*", (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return privateError(405, "Method not allowed");
    const path = decodedPath(new URL(c.req.url).pathname);
    if (!path) return privateError(404, "Not found");
    let relative: string;
    if (path === "/" || path === "/index.html" || SPA_PATH.test(path)) relative = "index.html";
    else if (BUILD_ASSET.test(path) || path === "/favicon.ico" || path === "/favicon.svg") relative = path.slice(1);
    else return privateError(404, "Not found");
    return bundleResponse(root, relative, c.req.method) ?? privateError(404, "Not found");
  });
  return async request => app.fetch(request);
}

export async function start() {
  // Validate before creating any listener, even when the build is missing.
  const config = loadConfig(process.env);
  const clientDir = resolve(process.env.CLIENT_DIR ?? "dist/client");
  if (!existsSync(clientDir)) throw new Error("Built client bundle missing; run npm run build");
  // A configured address list is usable only when the persistent registry has
  // one distinct JMAP account binding per address. Browser activation is limited
  // to those pre-provisioned rows; multi-mailbox mode never aliases inboxes.
  const outboundBinding = loadOutboundBinding(process.env);
  if (outboundBinding && !config.mailbox) {
    throw new Error("Outbound mailbox identities require a configured Stalwart JMAP binding.");
  }
  const addresses = configuredAddressesFrom(outboundBinding);
  let backend: MailBackend | null = null;
  let mailboxBackends: Map<string, MailBackend> | undefined;
  let mailboxRegistry: MailboxRegistry | undefined;
  if (config.mailbox && outboundBinding) {
    const db = openJournal(outboundBinding.dbPath);
    mailboxRegistry = new MailboxRegistry(db);
    mailboxBackends = createProductionMailboxBackends(config, mailboxRegistry.listAll(), outboundBinding, { db });
  } else if (!outboundBinding) {
    // Preserve the legacy single-account read path when outbound identities
    // are not configured. Sending remains refused without a sender binding.
    backend = createProductionBackend(config);
  }
  const fetch = createProductionHandler({
    config,
    clientDir,
    ...(backend ? { backend } : {}),
    ...(mailboxBackends ? { mailboxBackends } : {}),
    ...(mailboxRegistry ? { mailboxRegistry } : {}),
    ...(addresses ? { addresses } : {}),
  });
  const { serve } = await import("@hono/node-server");
  // Keep native Web API globals: the adapter's default shims affect unrelated code.
  return serve({ hostname: config.host, port: config.port, fetch, overrideGlobalObjects: false }, info => {
    console.log(`[harizco-post] listening on http://${info.address}:${info.port}`);
  });
}

// Importing this module (including the bundled artifact) must never listen.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await start(); }
  catch {
    console.error("[harizco-post] Startup refused: invalid web configuration or client bundle");
    process.exitCode = 1;
  }
}
