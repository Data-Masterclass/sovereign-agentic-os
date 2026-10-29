/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Platform Admin — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 * Deep-path imports remain valid when callers need a single sub-module.
 *
 * Note: settings, domains and tenant each export `_reset` (test helper) and a
 * durable-mirror `ensureHydrated`; callers that need those must import via the
 * direct path (they are intentionally NOT surfaced through this barrel to avoid
 * `export *` name collisions).
 */

// User management: list / get / create / update / archive users.
export * from '@tabs/admin/lib/users';

// Domain management: list / get / create / activeDomainIds.
export * from '@tabs/admin/lib/domains';

// Tenant management: get / update tenant (test/infra helpers `_reset` +
// `ensureHydrated` are direct-path only — see the note above).
export {
  type Residency,
  type Plan,
  type Tenant,
  currentTenantId,
  assertTenantAccess,
  getTenant,
  updateTenant,
} from '@tabs/admin/lib/tenant';

// Component status registry.
export * from '@tabs/admin/lib/platform';
