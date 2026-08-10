/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Connections — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import the tab through THIS module, never
 * through its internal files. The deep-path import `@/lib/connections/schema`
 * remains valid for client components that must avoid the `server-only` `store`
 * surface re-exported below.
 */

// Governed adapter — CRUD / list / promote / lifecycle (server-only).
export * from './store';

// Pure types + safe-preset templates.
export * from './schema';

// Builder-request → Admin-approve egress endpoints + outbound log.
export * from './egress-requests';
