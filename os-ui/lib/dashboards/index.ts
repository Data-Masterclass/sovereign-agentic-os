/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Dashboards — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 */

// Store ops: list/get/save/transition dashboards (server-only).
export * from './store.ts';

// Dashboard schema types (DashboardSpec, VizType, ChartSpec, etc.).
export * from './schema.ts';
