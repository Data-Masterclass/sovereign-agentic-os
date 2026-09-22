/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Big Bets — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 */

// Store ops: list/get/create/update bets and components (server-only).
export * from './store.ts';

// BigBet model types (BigBet, Actor, Tab, Lifecycle, etc.).
export * from './schema.ts';

// Component sources: cross-tab artifact resolution + Strategy up-link.
export * from './sources.ts';
