/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Data — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 * Deep-path imports remain valid for client components that must avoid
 * the `server-only` surfaces re-exported below.
 */

// Store ops: list/get/create/reassign datasets (server-only).
export * from './store.ts';

// Dataset schema types (Layer, Dataset, Grant, ColumnDoc, etc.).
export * from './schema.ts';

// OpenMetadata client — the governed catalog's system-of-record probe/pull.
export * from './openmetadata.ts';
