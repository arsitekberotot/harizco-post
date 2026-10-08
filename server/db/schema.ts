// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in LICENSE.
// SQL is embedded by Vitest/Vite and esbuild; no runtime checkout dependency.
import initialSchema from "./migrations/0001_integration.sql?raw";
import integrationLeases from "./migrations/0002_leases.sql?raw";

export const MIGRATIONS = [
	{ version: 1, sql: initialSchema },
	{ version: 2, sql: integrationLeases },
] as const;
export const JOURNAL_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
export const SCHEMA = initialSchema;
