/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Files — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 */

// Store ops: list/get/create/search files (server-only).
export * from './store.ts';

// File asset schema types (FileAsset, FileKind, Sensitivity, Provenance, etc.).
export * from './schema.ts';
