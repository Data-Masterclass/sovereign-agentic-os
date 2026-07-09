/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Connections — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import the tab through THIS module, never
 * through its internal files. Deep-path imports (`@/lib/connections/schema`,
 * `@/lib/connections/connectors`) remain valid for client components that must
 * avoid the `server-only` `store` surface re-exported below.
 */

// Governed adapter — CRUD / list / promote / lifecycle (server-only).
export * from './store';

// Pure types + safe-preset templates.
export * from './schema';

// Static connector catalogue (Files / Workspace) for the picker.
export * from './connectors';

// Builder-request → Admin-approve egress endpoints + outbound log.
export * from './egress-requests';
