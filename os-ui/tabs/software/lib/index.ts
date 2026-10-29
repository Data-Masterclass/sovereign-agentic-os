/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Software — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 */

// App CRUD + file ops (server-only).
export * from '@tabs/software/lib/apps';

// Software schema types (AppManifest, DeployState, ScanResult, etc.).
export * from '@tabs/software/lib/schema';
