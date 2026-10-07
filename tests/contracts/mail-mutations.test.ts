// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 8: flag mutations, folder operations, and safe drafts.

import { beforeEach, describe, expect, test } from "vitest";
import { createMockJmap, mockJmapFetch } from "../helpers/mock-jmap";
import { JmapClient } from "../../server/mail/jmap-client";
import { PROTECTED_ROLES, FolderError, validateFolderMutation } from "../../server/mail/folders";

let client: JmapClient;
let state: ReturnType<typeof createMockJmap>;

beforeEach(() => {
	state = createMockJmap();
	const { fetch } = mockJmapFetch(state);
	client = new JmapClient({
		baseUrl: "http://127.0.0.1:8080",
		auth: { username: "u", secret: "s" },
		fetch,
	});
});

describe("flagged state", () => {
	test("read/star changes are sent as keyword patches against the real email id", async () => {
		const patch = client.buildFlagPatch("e-1", { seen: true, flagged: true });
		expect(patch[0]).toBe("Email/set");
		const args = patch[1] as { update: Record<string, { "keywords/$seen"?: unknown; "keywords/$flagged"?: unknown }> };
		expect(args.update["e-1"]).toHaveProperty("keywords/$seen", true);
		expect(args.update["e-1"]).toHaveProperty("keywords/$flagged", true);
	});

	test("clearing a flag removes the keyword rather than setting it false", () => {
		const patch = client.buildFlagPatch("e-1", { seen: false });
		const args = patch[1] as { update: Record<string, Record<string, unknown>> };
		expect(args.update["e-1"]["keywords/$seen"]).toBeNull();
	});

	test("thread read marking addresses every email id given, not a thread id", () => {
		const patch = client.buildFlagPatch(["e-1", "e-2"], { seen: true });
		const args = patch[1] as { update: Record<string, unknown> };
		expect(Object.keys(args.update)).toEqual(["e-1", "e-2"]);
	});
});

describe("folder operations", () => {
	test("protected system roles cannot be deleted or renamed", () => {
		for (const role of PROTECTED_ROLES) {
			expect(() => validateFolderMutation({ role, operation: "delete" })).toThrow(FolderError);
			expect(() => validateFolderMutation({ role, operation: "rename" })).toThrow(/protected/i);
		}
	});

	test("custom folders can be created, renamed, and deleted with an explicit disposition", () => {
		expect(validateFolderMutation({ role: null, operation: "rename" })).toBe(true);
		expect(validateFolderMutation({ role: null, operation: "delete", moveToMailboxId: "mb-trash" })).toBe(true);
	});

	test("deleting a custom folder without a disposition is refused (no silent mail loss)", () => {
		expect(() => validateFolderMutation({ role: null, operation: "delete" })).toThrow(/disposition/i);
	});

	test("moving to trash is distinct from permanent deletion", () => {
		const move = client.buildMoveCalls(["e-1"], { from: "mb-inbox", to: "mb-trash" });
		expect(JSON.stringify(move)).toContain("mb-trash");
		expect(JSON.stringify(move)).not.toContain("destroy");
	});

	test("permanent deletion is never produced by the move helper", () => {
		const move = client.buildMoveCalls(["e-1"], { from: "mb-inbox", to: "mb-trash" });
		expect(JSON.stringify(move)).not.toMatch(/"Email\/set".*destroy/s);
	});
});
