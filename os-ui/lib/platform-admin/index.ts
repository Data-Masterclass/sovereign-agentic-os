/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Platform Admin — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 * Deep-path imports remain valid when callers need a single sub-module.
 *
 * Note: settings and domains each export `_reset` (test helper); callers
 * that need to reset test state must import via the direct path.
 */

// User management: list / get / create / update / archive users.
export * from './users.ts';

// Domain management: list / get / create / activeDomainIds.
export * from './domains.ts';

// Tenant management: get / update tenant.
export * from './tenant.ts';

// Component status registry.
export * from './platform.ts';
