// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: sync worker entrypoint.
//
// Runs the inbound receiving pipeline as a separate process from the web
// server, so mail credentials never live in the web process. Wires the concrete
// ports (Resend client, filesystem spool, JMAP importer) into the tested
// DiscoveryService / ImportPipeline / SyncRunner and drives the bounded loop.
//
// Shutdown is cooperative: SIGTERM/SIGINT stop the loop, release the lease, and
// purge nothing that has not already been released per-message.

import { loadSyncConfig } from "./config";
import { openJournal } from "./db/index";
import { MailboxRegistry } from "./mailboxes/registry";
import { RecipientRouter } from "./sync/recipients";
import { DiscoveryCheckpointStore, DiscoveryService } from "./sync/discovery";
import { ImportPipeline } from "./sync/import";
import { SyncRunner } from "./sync/runner";
import { InboundPoller } from "./sync/poller";
import { FsSpool } from "./sync/spool";
import { JmapImportAdapter } from "./sync/jmap-import";
import { ResendReceivingClient } from "./integrations/resend-receiving";

const OWNER = "sync-worker";

async function main(): Promise<void> {
	const config = loadSyncConfig(process.env);

	const db = openJournal(config.dbPath);
	const registry = new MailboxRegistry(db);
	const checkpoints = new DiscoveryCheckpointStore(db);
	const router = new RecipientRouter({ db, registry });

	const spool = new FsSpool({ dir: config.spoolDir });

	const importer = new JmapImportAdapter({
		baseUrl: config.stalwartUrl,
		auth: { username: config.stalwartUsername, secret: config.stalwartSecret },
		...(config.stalwartAccountId ? { accountId: config.stalwartAccountId } : {}),
	});

	const imports = new ImportPipeline({
		db,
		router,
		spool,
		jmap: importer,
		// A mailbox row carries its own JMAP account binding; fall back to the
		// configured default so an unbound mailbox is still importable.
		mailboxIdResolver: () => config.stalwartAccountId ?? "primary",
	});

	const discovery = new DiscoveryService({ db, router, checkpoints });

	const client = new ResendReceivingClient({
		apiKey: config.resendApiKey,
		baseUrl: config.resendBaseUrl,
	});

	const poller = new InboundPoller({
		db,
		provider: config.provider,
		client,
		imports,
		discovery,
		checkpoints,
	});

	const runner = new SyncRunner({
		db,
		router,
		intervalSeconds: config.intervalSeconds,
		owner: OWNER,
		poll: poller.poll,
	});

	if (!runner.acquireLease()) {
		console.error(`[harizco-sync] another worker holds the lease; exiting.`);
		process.exit(0);
	}

	let stopping = false;
	const shutdown = (signal: string): void => {
		if (stopping) return;
		stopping = true;
		console.log(`[harizco-sync] received ${signal}; stopping after the current poll.`);
		runner.stop();
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));

	console.log(
		`[harizco-sync] started (provider=${config.provider}, interval=${config.intervalSeconds}s, db=${config.dbPath})`,
	);

	// Cooperative loop: one bounded poll, then wait the (possibly backed-off)
	// delay. A failed/partial poll extends the delay instead of hammering the
	// provider.
	while (!stopping) {
		try {
			const outcome = await runner.runOnce();
			if (outcome) {
				// Content-free operational log: counts only, never recipients,
				// subjects, tokens, or signed URLs.
				console.log(
					`[harizco-sync] poll pages=${outcome.pages} discovered=${outcome.discovered} imported=${outcome.imported} failed=${outcome.failed}`,
				);
			}
		} catch {
			// runOnce isolates poll failures; this guards the loop itself.
			console.error(`[harizco-sync] poll loop error; will retry after backoff.`);
		}

		const waitMs = runner.nextDelaySeconds() * 1000;
		await sleepInterruptible(waitMs, () => stopping);
	}

	console.log(`[harizco-sync] stopped cleanly.`);
	db.close();
}

/** Sleep, but wake early when a shutdown signal arrives. */
function sleepInterruptible(ms: number, isStopping: () => boolean): Promise<void> {
	return new Promise((resolve) => {
		const step = 500;
		let waited = 0;
		const timer = setInterval(() => {
			waited += step;
			if (isStopping() || waited >= ms) {
				clearInterval(timer);
				resolve();
			}
		}, step);
	});
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : "unknown error";
	console.error(`[harizco-sync] fatal: ${message}`);
	process.exit(1);
});
