/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Files — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 */

// Store ops: list/get/create/search files (server-only).
export * from '@tabs/files/lib/store';

// Hybrid search (BM25 + k-NN over the `files` index, fused; keyword fallback, labelled).
export { searchFilesHybrid, KEYWORD_ONLY_NOTE, type FileSearchResult, type FileSearchHit, type FileSearchMode } from '@tabs/files/lib/search';

// File asset schema types (FileAsset, FileKind, Sensitivity, Provenance, etc.).
export * from '@tabs/files/lib/schema';
