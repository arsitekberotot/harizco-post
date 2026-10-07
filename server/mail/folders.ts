// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: folder operation policy.
//
// System folders are identified by JMAP role. Their roles are load-bearing for
// the mail client (drafts, trash, sent), so they cannot be renamed or deleted
// from the browser. A custom folder deletion must say where its mail goes.

export class FolderError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "FolderError";
	}
}

/** Roles that the mail client depends on and that must not be mutated. */
export const PROTECTED_ROLES = ["inbox", "drafts", "sent", "trash", "junk", "archive"] as const;

export type FolderOperation = "create" | "rename" | "delete";

export interface FolderMutation {
	role: string | null;
	operation: FolderOperation;
	/** Required when deleting a custom folder: where its messages are moved. */
	moveToMailboxId?: string;
}

const PROTECTED = new Set<string>(PROTECTED_ROLES);

/**
 * Validate a folder mutation. Throws FolderError for any disallowed change so
 * the route can return an actionable error rather than a silent partial write.
 */
export function validateFolderMutation(mutation: FolderMutation): true {
	const { role, operation, moveToMailboxId } = mutation;

	if (operation === "create") {
		// Creating a custom folder is always allowed; a new folder never claims
		// a protected role.
		return true;
	}

	if (role && PROTECTED.has(role)) {
		throw new FolderError(
			"protected_role",
			`The "${role}" folder is a protected system folder and cannot be ${operation}d.`,
		);
	}

	if (operation === "delete") {
		if (!moveToMailboxId) {
			throw new FolderError(
				"missing_disposition",
				"Deleting a custom folder requires a disposition: specify moveToMailboxId for its remaining messages.",
			);
		}
		if (moveToMailboxId === mutation.role) {
			throw new FolderError("invalid_disposition", "Cannot move a folder's mail into the folder being deleted.");
		}
	}

	return true;
}
