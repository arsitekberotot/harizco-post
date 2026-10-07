// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: filesystem spool for raw MIME bytes.
//
// Raw messages are staged on a private local directory before upload, and
// released only once the canonical copy in Stalwart is proven by readback.
// The spool is intentionally boring: content-addressed by a random key, written
// with 0600 permissions, and never left readable after a successful import.

import { mkdirSync, rmSync } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { SpoolPort } from "./import";

export interface FsSpoolOptions {
	/** Directory the spool owns. Created with 0700 if missing. */
	dir: string;
	/** Hard ceiling for a single spooled message. */
	maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class FsSpool implements SpoolPort {
	readonly #dir: string;
	readonly #maxBytes: number;

	constructor(opts: FsSpoolOptions) {
		if (!opts.dir) throw new Error("FsSpool requires a directory.");
		this.#dir = opts.dir;
		this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
		mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
	}

	async write(bytes: Uint8Array): Promise<string> {
		if (bytes.byteLength === 0) throw new Error("Refusing to spool an empty message.");
		if (bytes.byteLength > this.#maxBytes) {
			throw new Error(`Message of ${bytes.byteLength} bytes exceeds the spool limit of ${this.#maxBytes}.`);
		}
		const key = `${Date.now()}-${randomUUID()}.eml`;
		const path = this.#pathFor(key);
		// Write with owner-only permissions from the first byte.
		const handle = await open(path, "wx", 0o600);
		try {
			await handle.writeFile(bytes);
		} finally {
			await handle.close();
		}
		return key;
	}

	async read(key: string): Promise<Uint8Array> {
		return new Uint8Array(await readFile(this.#pathFor(key)));
	}

	async release(key: string): Promise<void> {
		rmSync(this.#pathFor(key), { force: true });
	}

	/** Best-effort removal of every staged message (used on shutdown). */
	purge(): void {
		rmSync(this.#dir, { recursive: true, force: true });
		mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
	}

	/** Refuse any key that could escape the spool directory. */
	#pathFor(key: string): string {
		if (key.includes("/") || key.includes("\\") || key.includes("..")) {
			throw new Error(`Invalid spool key: ${key}`);
		}
		return join(this.#dir, key);
	}
}

/** A no-op spool used when import is disabled; it never claims success. */
export const disabledSpool: SpoolPort = {
	async write() {
		throw new Error("Spooling is disabled.");
	},
	async read() {
		throw new Error("Spooling is disabled.");
	},
	async release() {
		// Nothing was written.
	},
};

export { writeFile };
